import {Presentation} from './model.js';

/**
 * Read-only durable Project browsing owner.
 *
 * Images owns ProjectDescriptor semantics, storage and authorization. This
 * module consumes that canonical descriptor unchanged through
 * ImageClientAdapter.readProject, discovers exactly one Project Presentation,
 * and owns Project-specific view orchestration. Compositor remains the sole
 * owner of view admission and logical lifecycle. This module never stores a
 * membership copy, creates a Project Command, or infers target authority from
 * membership.
 */

const PROJECT_SUBJECT_KIND = 'project';
const PROJECT_PRESENTATION_KIND = 'project';
const PROJECT_VIEW_ID = 'project-view';
const GENERATION_CANCELLED = Symbol('ProjectBrowser generation cancelled');

class ProjectPresentationError extends Error {
  constructor(message, {failures = []} = {}) {
    super(message);
    this.name = 'ProjectPresentationError';
    this.failures = failures;
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function createProjectSubject({imageId, projectId} = {}) {
  return Object.freeze({
    kind: PROJECT_SUBJECT_KIND,
    imageId: requiredText(imageId, 'Project subject imageId'),
    projectId: requiredText(projectId, 'Project subject projectId'),
  });
}

function requireProjectSubject(subject) {
  if (!subject || subject.kind !== PROJECT_SUBJECT_KIND) {
    throw new TypeError('ProjectBrowser requires a Project subject');
  }
  return createProjectSubject(subject);
}

function sameProjectSubject(a, b) {
  return Boolean(a && b
    && a.kind === PROJECT_SUBJECT_KIND && b.kind === PROJECT_SUBJECT_KIND
    && a.imageId === b.imageId && a.projectId === b.projectId);
}

function projectPresentationId(subject) {
  // JSON string encoding makes the pair unambiguous even when either opaque id
  // contains punctuation. Identity includes BOTH Image and Project.
  return `project:${JSON.stringify(subject.imageId)}:${JSON.stringify(subject.projectId)}`;
}

function createProjectPresentationProvider() {
  return Object.freeze({
    id: 'project-browser',
    present(subject, context = {}) {
      if (!subject || subject.kind !== PROJECT_SUBJECT_KIND) return null;
      const project = context.project;
      if (!project || typeof project !== 'object' || project.projectId !== subject.projectId) {
        throw new TypeError('Project presentation requires the matching canonical ProjectDescriptor');
      }
      if (typeof project.name !== 'string' || !Array.isArray(project.members)) {
        throw new TypeError('Project presentation requires a canonical ProjectDescriptor name and members');
      }
      return new Presentation({
        id: projectPresentationId(subject),
        subject,
        kind: PROJECT_PRESENTATION_KIND,
        // Preserve the Images-owned descriptor by identity. No copied targets,
        // membership array, normalization or shadow Project model.
        context: {project},
        state: {},
      });
    },
  });
}

function exactProjectPresentation({subject, presentations, failures}) {
  const candidates = presentations.filter((presentation) => (
    presentation.kind === PROJECT_PRESENTATION_KIND
    && sameProjectSubject(presentation.subject, subject)
  ));
  if (candidates.length !== 1) {
    throw new ProjectPresentationError(
      candidates.length === 0
        ? `no Project presentation was discovered for ${subject.imageId}/${subject.projectId}`
        : `ambiguous Project presentations for ${subject.imageId}/${subject.projectId}: ${candidates.length}`,
      {failures},
    );
  }
  return candidates[0];
}

function toPresentationDescriptor(presentation) {
  return {
    kind: presentation.kind,
    subject: presentation.subject,
    parameters: presentation.context ?? {},
  };
}

/**
 * Resolve a transient SemanticUi action index against the CURRENT Project
 * presentation descriptor. The durable member key remains in the canonical
 * member; the integer is never identity and never authority.
 */
function resolveProjectMemberTarget(presentationDescriptor, key) {
  const members = presentationDescriptor?.parameters?.project?.members;
  if (!Array.isArray(members)
      || !Number.isSafeInteger(key) || key < 0 || key >= members.length) {
    return null;
  }
  const target = members[key]?.target;
  if (!target || target.kind !== 'ref'
      || typeof target.imageId !== 'string' || target.imageId.length === 0
      || typeof target.objectId !== 'string' || target.objectId.length === 0) {
    return null;
  }
  return target;
}

function createProjectBrowser({adapter, presentationRegistry, compositor} = {}) {
  if (!adapter || typeof adapter.readProject !== 'function' || typeof adapter.observe !== 'function') {
    throw new TypeError('createProjectBrowser requires an adapter with readProject and observe');
  }
  if (!presentationRegistry || typeof presentationRegistry.discover !== 'function') {
    throw new TypeError('createProjectBrowser requires a PresentationRegistry');
  }
  if (!compositor
      || typeof compositor.openView !== 'function'
      || typeof compositor.presentOn !== 'function'
      || typeof compositor.closeView !== 'function') {
    throw new TypeError('createProjectBrowser requires a Compositor');
  }

  let generation = 0;
  let activeSubject = null;
  let projectViewOpen = false;
  let lane = Promise.resolve();
  const follows = new Set();
  let generationCancellation = createGenerationCancellation();

  function createGenerationCancellation() {
    let cancel;
    const promise = new Promise((resolve) => {
      cancel = () => resolve(GENERATION_CANCELLED);
    });
    return {promise, cancel};
  }

  function beginGeneration() {
    generationCancellation.cancel();
    generation += 1;
    generationCancellation = createGenerationCancellation();
    return Object.freeze({generation, cancelled: generationCancellation.promise});
  }

  function enqueue(operation) {
    const result = lane.then(operation, operation);
    lane = result.catch(() => {});
    return result;
  }

  async function browse(subject, {authority = null} = {}) {
    const required = requireProjectSubject(subject);
    const project = await adapter.readProject({
      imageId: required.imageId,
      projectId: required.projectId,
      authority,
    });
    const discovery = presentationRegistry.discover(required, {project});
    const presentation = exactProjectPresentation({subject: required, ...discovery});
    return Object.freeze({presentation, failures: discovery.failures});
  }

  async function browseUntilInvalidated(subject, options, cancelled) {
    // Images Project reads do not accept a cancellation signal. Keep their
    // eventual failure terminally handled, but let generation invalidation
    // release the presentation lane so replacement is never held hostage by
    // an obsolete read.
    const operation = browse(subject, options);
    operation.catch(() => {});
    return Promise.race([operation, cancelled]);
  }

  function stopPriorFollows() {
    for (const follow of [...follows]) follow.stop();
  }

  /**
   * Replace the active Project fail-closed. Prior follows stop immediately;
   * the old view is closed before the new authorized read. A failed read leaves
   * no active Project and no stale Project view.
   */
  function open(subject, {authority = null, viewDescriptor = {kind: 'canvas', width: 64, height: 64}} = {}) {
    const required = requireProjectSubject(subject);
    stopPriorFollows();
    const nextGeneration = beginGeneration();
    const expectedGeneration = nextGeneration.generation;
    activeSubject = null;

    return enqueue(async () => {
      if (expectedGeneration !== generation) return null;
      if (projectViewOpen) {
        try {
          await compositor.closeView(PROJECT_VIEW_ID);
        } finally {
          projectViewOpen = false;
        }
      }
      if (expectedGeneration !== generation) return null;
      try {
        const result = await browseUntilInvalidated(required, {authority}, nextGeneration.cancelled);
        if (result === GENERATION_CANCELLED) return null;
        const {presentation, failures} = result;
        if (expectedGeneration !== generation) return null;
        const descriptor = toPresentationDescriptor(presentation);
        await compositor.openView({
          viewId: PROJECT_VIEW_ID,
          viewDescriptor,
          presentationDescriptor: descriptor,
        });
        if (expectedGeneration !== generation) {
          await compositor.closeView(PROJECT_VIEW_ID);
          return null;
        }
        projectViewOpen = true;
        activeSubject = required;
        return Object.freeze({viewId: PROJECT_VIEW_ID, presentationDescriptor: descriptor, failures});
      } catch (error) {
        activeSubject = null;
        // Compositor.openView retains a lost logical view after an attach
        // failure. Remove it so every replacement failure has one outcome.
        if (!projectViewOpen && typeof compositor.viewStatus === 'function'
            && compositor.viewStatus(PROJECT_VIEW_ID) !== null) {
          await compositor.closeView(PROJECT_VIEW_ID).catch(() => {});
        }
        throw error;
      }
    });
  }

  function refreshInGeneration({
    subject, authority, expectedGeneration, cancelled, isCancelled = () => false,
  }) {
    return enqueue(async () => {
      if (isCancelled()
          || expectedGeneration !== generation || !sameProjectSubject(activeSubject, subject)) return null;
      const result = await browseUntilInvalidated(subject, {authority}, cancelled);
      if (result === GENERATION_CANCELLED || isCancelled()) return null;
      const {presentation, failures} = result;
      if (expectedGeneration !== generation || !sameProjectSubject(activeSubject, subject)) return null;
      const descriptor = toPresentationDescriptor(presentation);
      await compositor.presentOn(PROJECT_VIEW_ID, descriptor);
      if (expectedGeneration !== generation || !sameProjectSubject(activeSubject, subject)) return null;
      return Object.freeze({viewId: PROJECT_VIEW_ID, presentationDescriptor: descriptor, failures});
    });
  }

  function refresh({authority = null} = {}) {
    const subject = activeSubject;
    if (!subject) throw new TypeError('refresh requires an active Project');
    return refreshInGeneration({
      subject,
      authority,
      expectedGeneration: generation,
      cancelled: generationCancellation.promise,
    });
  }

  function follow({authority = null, observationBlockId, afterCursor, intervalMs, onUpdate, onError} = {}) {
    const subject = activeSubject;
    if (!subject) throw new TypeError('follow requires an active Project');
    const expectedGeneration = generation;
    const generationCancelled = generationCancellation.promise;
    const controller = new AbortController();
    let settleAbort;
    const aborted = new Promise((resolve) => { settleAbort = resolve; });
    const handle = {
      stop() {
        if (!controller.signal.aborted) {
          controller.abort();
          settleAbort({aborted: true});
        }
      },
      signal: controller.signal,
      done: null,
    };

    const worker = (async () => {
      try {
        const changes = adapter.observe(subject.imageId, {
          authority,
          blockId: observationBlockId,
          afterCursor,
          signal: controller.signal,
          intervalMs,
        });
        for await (const change of changes) {
          if (controller.signal.aborted || expectedGeneration !== generation) break;
          // Images Project reads are not cancellable. Race the operation with
          // follow and generation cancellation so the lane and `done` settle
          // promptly; the read remains terminally handled and cannot present
          // after this follow is stopped.
          const refreshCancelled = Promise.race([
            generationCancelled,
            aborted.then(() => GENERATION_CANCELLED),
          ]);
          const operation = refreshInGeneration({
            subject,
            authority,
            expectedGeneration,
            cancelled: refreshCancelled,
            isCancelled: () => controller.signal.aborted,
          });
          operation.catch(() => {});
          const result = await Promise.race([operation, aborted]);
          if (controller.signal.aborted || expectedGeneration !== generation || result?.aborted) break;
          if (result && onUpdate) await onUpdate(result.presentationDescriptor, change);
        }
      } catch (error) {
        if (controller.signal.aborted || expectedGeneration !== generation || error?.name === 'AbortError') return;
        if (onError) {
          await onError(error);
          return;
        }
        throw error;
      }
    })();

    // `done` is a lifecycle acknowledgement, so it settles at abort even when
    // the underlying Images operation cannot itself be cancelled. `worker` has
    // handlers attached by this race and its own catch path, preventing a late
    // rejection from becoming unhandled.
    handle.done = Promise.race([worker, aborted.then(() => undefined)])
      .finally(() => follows.delete(handle));
    follows.add(handle);
    return Object.freeze(handle);
  }

  return Object.freeze({
    browse,
    open,
    refresh,
    follow,
    resolveItem: resolveProjectMemberTarget,
    activeSubject: () => activeSubject,
    viewId: PROJECT_VIEW_ID,
  });
}

export {
  PROJECT_PRESENTATION_KIND,
  PROJECT_SUBJECT_KIND,
  PROJECT_VIEW_ID,
  ProjectPresentationError,
  createProjectBrowser,
  createProjectPresentationProvider,
  createProjectSubject,
  resolveProjectMemberTarget,
};

export default {
  createProjectBrowser,
  createProjectPresentationProvider,
  createProjectSubject,
  resolveProjectMemberTarget,
};
