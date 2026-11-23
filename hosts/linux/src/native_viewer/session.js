// Native composition only: ordinary Environment owners perform every semantic
// read/navigation/presentation. The host supplies transport and renderer ports.
import {createImageReadConnection} from 'image-read-connection';
import {createRemoteImageClientAdapter} from 'image-client-adapter';
import {createCompositor} from 'compositor';
import {createEnvironmentShell} from 'environment-shell';
import {createObjectNavigator} from 'object-navigator';
import {createCommandRegistry} from 'command-registry';
import {createPresentationRegistry} from 'presentation-registry';
import {createSelectionModel} from 'selection-model';
import {createObjectInspectorProvider, createUnavailableRefProvider, createUnauthorizedRefProvider} from 'object-presentation-providers';
import {createProjectBrowser, createProjectSubject, createProjectPresentationProvider} from 'project-browser';
import {referencesOfValue} from 'portable-runtime';
import {createNativeReadRequest} from 'native/read-transport';

export async function openNativeViewer({rendererAdapter, imageId, projectId, memberKey}) {
  const connection = createImageReadConnection({request:createNativeReadRequest()});
  const adapter = createRemoteImageClientAdapter({connection});
  const presentations = createPresentationRegistry();
  presentations.register(createProjectPresentationProvider());
  presentations.register(createObjectInspectorProvider());
  presentations.register(createUnavailableRefProvider());
  presentations.register(createUnauthorizedRefProvider());
  const navigator = createObjectNavigator({adapter, presentationRegistry:presentations,
    commandRegistry:createCommandRegistry(), referencesOfValue});
  const compositor = createCompositor({rendererAdapter});
  const shell = createEnvironmentShell({navigator, selectionModel:createSelectionModel(), compositor,
    writableSlots:adapter.writableSlots});
  const browser = createProjectBrowser({adapter, presentationRegistry:presentations, compositor});
  let handler = null;
  let activationFailed = false;
  let closed = false;
  const unsubscribe = shell.bindIntents({
    adapter:{onIntent(callback) { handler = callback; return () => { handler = null; }; }},
    inspectorNavigation:true,
    activationBindings:[{viewId:browser.viewId, resolveItem:browser.resolveItem}],
    onActivateError() { activationFailed = true; },
  });
  const handles = () => ({project:compositor.surfaceHandleForView(browser.viewId),
    inspector:compositor.surfaceHandleForView(shell.inspectorViewId)});
  async function activate(surfaceHandle, intent) {
    if (closed) throw new Error('Viewer closed.');
    activationFailed = false;
    await handler?.(intent, surfaceHandle);
    if (activationFailed) throw new Error('Activation failed.');
    return handles();
  }
  async function close() {
    if (closed) return;
    closed = true;
    connection.close();
    unsubscribe();
    await compositor.destroy();
  }
  try {
    await compositor.openView({viewId:shell.inspectorViewId,
      viewDescriptor:{kind:'canvas',width:480,height:600},
      presentationDescriptor:{kind:'inspector',subject:null,parameters:{fields:{},references:[]}}});
    const opened = await browser.open(createProjectSubject({imageId,projectId}), {
      viewDescriptor:{kind:'canvas',width:320,height:600},
    });
    // An explicit operator member key is a requested action, never a default
    // prefetch. Route it through the same shell binding as a GTK button.
    if (memberKey !== undefined) {
      const ordinal = opened.presentationDescriptor.parameters.project.members.findIndex(({key}) => key === memberKey);
      if (ordinal < 0) throw new Error('Requested Project member is unavailable.');
      await activate(handles().project, {kind:'activate-item',key:ordinal});
    }
    return Object.freeze({handles, activate, close, async refresh() {
      if (closed) throw new Error('Viewer closed.');
      await browser.refresh();
      await shell.inspectSelected();
      return handles();
    }});
  } catch (error) {
    await close();
    throw error;
  }
}
