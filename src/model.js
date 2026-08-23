function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireSubject(subject) {
  if (subject === null || subject === undefined) {
    throw new TypeError('subject is required');
  }
  return subject;
}

/**
 * Semantic description of one way to present an image subject.
 *
 * `subject` is intentionally opaque to this package. In production it will
 * normally be an image ObjectRef or Value understood through a lagrange-images
 * client. A Presentation is not an authority token and does not own its subject.
 */
export class Presentation {
  constructor({id, subject, kind, context = {}, state = {}}) {
    this.id = requireNonEmptyString(id, 'id');
    this.subject = requireSubject(subject);
    this.kind = requireNonEmptyString(kind, 'kind');
    this.context = Object.freeze({...context});
    this.state = Object.freeze({...state});
    Object.freeze(this);
  }

  withState(state) {
    return new Presentation({
      id: this.id,
      subject: this.subject,
      kind: this.kind,
      context: this.context,
      state,
    });
  }
}

/**
 * Inspectable environment operation.
 *
 * Applicability is a UI/discovery concern. `invoke` must still cross the image
 * authorization boundary; discovering a command never grants permission to run it.
 */
export class Command {
  constructor({id, title, appliesTo = () => true, invoke}) {
    this.id = requireNonEmptyString(id, 'id');
    this.title = requireNonEmptyString(title, 'title');
    if (typeof appliesTo !== 'function') {
      throw new TypeError('appliesTo must be a function');
    }
    if (typeof invoke !== 'function') {
      throw new TypeError('invoke must be a function');
    }
    this.appliesTo = appliesTo;
    this.invoke = invoke;
    Object.freeze(this);
  }

  applies(subject, context = {}) {
    return Boolean(this.appliesTo(subject, context));
  }

  async run(subject, context = {}) {
    if (!this.applies(subject, context)) {
      throw new Error(`command ${this.id} does not apply to the subject`);
    }
    return this.invoke(subject, context);
  }
}

/**
 * Durable intention for inhabiting part of an image.
 *
 * This class models the environment-level value only. Persistence belongs to
 * lagrange-images: a Perspective becomes durable by being represented as an image
 * object, not by this package inventing a second store.
 */
export class Perspective {
  constructor({id, subject, title = null, presentations = [], layout = null}) {
    this.id = requireNonEmptyString(id, 'id');
    this.subject = requireSubject(subject);
    this.title = title;
    this.presentations = Object.freeze([...presentations]);
    this.layout = layout;
    Object.freeze(this);
  }

  withPresentations(presentations) {
    return new Perspective({
      id: this.id,
      subject: this.subject,
      title: this.title,
      presentations,
      layout: this.layout,
    });
  }

  withLayout(layout) {
    return new Perspective({
      id: this.id,
      subject: this.subject,
      title: this.title,
      presentations: this.presentations,
      layout,
    });
  }
}

/**
 * Ephemeral state of one connected UI client.
 *
 * A Session is explicitly not part of durable image semantics. Renderers can keep
 * arbitrary local details in `state` without causing image history churn.
 */
export class Session {
  constructor({principal, perspective = null, state = {}}) {
    if (principal === null || principal === undefined) {
      throw new TypeError('principal is required');
    }
    this.principal = principal;
    this.perspective = perspective;
    this.state = {...state};
  }

  set(key, value) {
    this.state[key] = value;
    return value;
  }

  get(key) {
    return this.state[key];
  }
}
