/* Synthetic hook/element harness: tests component logic, NOT React Native layout,
 * native dialogs, keyboard/safe-area geometry or actual device screenshots. */
const {test, beforeEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const {execFileSync} = require('node:child_process');
const ts = (() => {
  try {
    return require('typescript');
  } catch {
    return require(
      path.join(
        execFileSync('npm', ['root', '-g'], {encoding: 'utf8'}).trim(),
        'typescript',
      ),
    );
  }
})();
const root = path.resolve(__dirname, '..');
const db = new Map();
const alerts = [];
const stores = {modelStore: {}, chatSessionStore: {}, palStore: {pals: []}};
let theme;
let h;
const React = {
  createElement(type, props, ...children) {
    return {type, props: {...props, children: children.flat()}};
  },
  Fragment: 'Fragment',
  useState(initial) {
    const i = h.cursor++;
    if (!(i in h.slots)) {
      h.slots[i] = typeof initial === 'function' ? initial() : initial;
    }
    return [
      h.slots[i],
      next => {
        const value = typeof next === 'function' ? next(h.slots[i]) : next;
        if (!Object.is(h.slots[i], value)) {
          h.slots[i] = value;
          h.dirty = true;
        }
      },
    ];
  },
  useRef(initial) {
    const i = h.cursor++;
    if (!(i in h.slots)) {
      h.slots[i] = {current: initial};
    }
    return h.slots[i];
  },
  useEffect(effect, deps) {
    const i = h.cursor++;
    const previous = h.effects[i];
    if (!previous || deps.some((x, j) => !Object.is(x, previous.deps[j]))) {
      h.pending.push(() => {
        previous?.cleanup?.();
        h.effects[i] = {deps, cleanup: effect()};
      });
    }
  },
};
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'react') {
    return {__esModule: true, default: React, ...React};
  }
  if (request === 'react-native') {
    return {
      Alert: {alert: (...args) => alerts.push(args)},
      View: 'View',
      ScrollView: 'ScrollView',
      StyleSheet: {create: s => s},
      useWindowDimensions: () => ({height: 800, width: 390}),
    };
  }
  if (request === 'react-native-paper') {
    const Dialog = () => {};
    Dialog.Title = 'Dialog.Title';
    Dialog.ScrollArea = 'Dialog.ScrollArea';
    Dialog.Actions = 'Dialog.Actions';
    return {
      Button: 'Button',
      Dialog,
      HelperText: 'HelperText',
      Portal: 'Portal',
      Switch: 'Switch',
      Text: 'Text',
      TextInput: 'TextInput',
    };
  }
  if (request === 'mobx-react') {
    return {observer: x => x};
  }
  if (request === 'mobx') {
    return {makeAutoObservable: () => {}, runInAction: f => f()};
  }
  if (request === '@react-native-async-storage/async-storage') {
    return {
      __esModule: true,
      default: {
        getItem: async k => db.get(k) ?? null,
        setItem: async (k, v) => db.set(k, v),
        removeItem: async k => db.delete(k),
      },
    };
  }
  if (parent?.filename.startsWith(root)) {
    const target = path.resolve(path.dirname(parent.filename), request);
    if (target === path.join(root, 'src/store')) return stores;
    if (target === path.join(root, 'src/hooks/useTheme'))
      return {useTheme: () => theme};
    if (target === path.join(root, 'src/utils/types'))
      return {ModelOrigin: {REMOTE: 'remote'}};
    if (target === path.join(root, 'src/utils'))
      return {formatBytes: x => String(x)};
    if (target === path.join(root, 'src/utils/memoryEstimator'))
      return {getModelMemoryRequirement: () => 123456};
  }
  return load.call(this, request, parent, isMain);
};
const transpile = (module, filename) => {
  const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  });
  assert.equal(
    out.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error)
      .length ?? 0,
    0,
  );
  module._compile(out.outputText, filename);
};
require.extensions['.ts'] = transpile;
require.extensions['.tsx'] = transpile;
const storage = require(
  path.join(root, 'src/services/conversation/storage.ts'),
);
const memory = require(path.join(root, 'src/services/conversation/optmem.ts'));
const {ConversationControls} = require(
  path.join(
    root,
    'src/components/ConversationControls/ConversationControls.tsx',
  ),
);
const tick = () => new Promise(resolve => setImmediate(resolve));
function render() {
  h.cursor = 0;
  h.dirty = false;
  h.tree = ConversationControls();
  const pending = h.pending.splice(0);
  pending.forEach(f => f());
  return h.tree;
}
async function flush() {
  for (let i = 0; i < 30; i++) {
    if (h.dirty) render();
    await tick();
    if (!h.dirty) return;
  }
  throw new Error('Synthetic render did not settle');
}
function nodes(node) {
  return !node || typeof node !== 'object'
    ? []
    : [node, ...(node.props?.children ?? []).flatMap(nodes)];
}
function byId(id) {
  const found = nodes(h.tree).find(n => n.props.testID === id);
  assert.ok(found, `missing ${id}`);
  return found;
}
function button(label) {
  const found = nodes(h.tree).find(
    n => n.type === 'Button' && n.props.children.includes(label),
  );
  assert.ok(found, `missing button ${label}`);
  return found;
}
function input(label) {
  const found = nodes(h.tree).find(
    n => n.type === 'TextInput' && n.props.label === label,
  );
  assert.ok(found, `missing input ${label}`);
  return found;
}
async function open() {
  byId('conversation-options').props.onPress();
  await flush();
}
beforeEach(async () => {
  db.clear();
  alerts.length = 0;
  h = {cursor: 0, slots: [], effects: [], pending: [], dirty: true, tree: null};
  theme = {
    dark: true,
    colors: {
      background: '#121212',
      surface: '#202020',
      surfaceVariant: '#303030',
      onSurface: '#eeeeee',
      onSurfaceVariant: '#dddddd',
    },
  };
  stores.chatSessionStore = {
    activeSessionId: 'chat-1',
    activePalId: undefined,
    sessions: [{id: 'chat-1'}],
  };
  stores.palStore = {pals: []};
  stores.modelStore = {
    activeModel: undefined,
    inferencing: false,
    isContextLoading: false,
    models: [],
    contextInitParams: {n_ctx: 1024, n_batch: 256, n_ubatch: 64},
    setNContext: () => {},
  };
  storage.conversationRuntime.statuses = {};
  await flush();
});
test('Memories entry exists and opens without loading a model', async () => {
  const entry = byId('conversation-options');
  assert.equal(entry.props.disabled, undefined);
  assert.ok(
    entry.props.children.flat().some(x => String(x).includes('Memories')),
  );
  await open();
  assert.ok(nodes(h.tree).some(n => n.props.visible === true));
});
test('memory consent persists immediately without validating context or model prompt', async () => {
  await open();
  assert.equal(byId('use-memories-switch').props.disabled, false);
  await byId('use-memories-switch').props.onValueChange(true);
  await flush();
  assert.equal((await storage.readPreferences('chat-1')).useMemories, true);
  assert.ok(
    byId('conversation-options').props.children.includes(
      'Memories: on · Context',
    ),
  );
});
test('memory opt-out persists immediately without Save settings', async () => {
  await storage.savePreferences('chat-1', {
    version: 1,
    useMemories: true,
    autoCompact: true,
  });
  h.dirty = true;
  await flush();
  await open();
  await byId('use-memories-switch').props.onValueChange(false);
  await flush();
  assert.equal((await storage.readPreferences('chat-1')).useMemories, false);
});
test('manual notes can be managed with no model and model-memory consent off', async () => {
  await open();
  const note = input('Add a memory (one line, 280 UTF-8 bytes)');
  assert.equal(note.props.disabled, false);
  note.props.onChangeText('I prefer tea');
  await flush();
  await button('Save memory').props.onPress();
  await flush();
  assert.equal((await storage.mobileMemory.read()).log[0].text, 'I prefer tea');
  assert.equal((await storage.readPreferences('chat-1')).useMemories, false);
});
test('Pal isolation switch persists without a model or separate Save settings', async () => {
  stores.palStore.pals = [{id: 'alpha', type: 'local', name: 'Alpha'}];
  stores.chatSessionStore.activePalId = 'alpha';
  h.dirty = true;
  await flush();
  await open();
  await byId('pal-memory-isolation-switch').props.onValueChange(true);
  await flush();
  assert.equal(await storage.readPalMemoryIsolation('alpha'), true);
  input('Add a memory (one line, 280 UTF-8 bytes)').props.onChangeText(
    'Alpha note',
  );
  await flush();
  await button('Save memory').props.onPress();
  await flush();
  assert.equal(
    (await storage.mobileMemory.read(storage.palMemoryScope('alpha'))).log
      .length,
    1,
  );
  assert.equal((await storage.mobileMemory.read()).log.length, 0);
});
test('explicit erasure remains available with model-memory consent off', async () => {
  await storage.mobileMemory.update(
    s => memory.noteMemory(s, 'Private note', 'old-chat'),
    async () => {},
  );
  await open();
  const erase = button('Erase shared memories');
  assert.equal(erase.props.disabled, false);
  await erase.props.onPress();
  alerts
    .at(-1)[2]
    .find(a => a.text === 'Erase')
    .onPress();
  await flush();
  assert.equal((await storage.mobileMemory.read()).log.length, 0);
});
test('old erasure confirmation cannot erase a different Pal scope', async () => {
  stores.palStore.pals = [
    {id: 'alpha', type: 'local', name: 'Alpha'},
    {id: 'beta', type: 'local', name: 'Beta'},
  ];
  stores.chatSessionStore.activePalId = 'alpha';
  await storage.savePalMemoryIsolation('alpha', true);
  await storage.savePalMemoryIsolation('beta', true);
  await storage.mobileMemory.update(
    s => memory.noteMemory(s, 'Alpha note', 'old-chat'),
    async () => {},
    storage.palMemoryScope('alpha'),
  );
  h.dirty = true;
  await flush();
  await open();
  await button("Erase Alpha's memories").props.onPress();
  const confirm = alerts.at(-1)[2].find(a => a.text === 'Erase');
  stores.chatSessionStore.activePalId = 'beta';
  h.dirty = true;
  await flush();
  confirm.onPress();
  await flush();
  assert.equal(
    (await storage.mobileMemory.read(storage.palMemoryScope('alpha'))).log
      .length,
    1,
  );
});
test('root, dialog scroll area, text inputs and text receive the active dark theme', async () => {
  await open();
  assert.equal(
    byId('conversation-controls-surface').props.style.backgroundColor,
    theme.colors.background,
  );
  assert.equal(
    nodes(h.tree).find(n => n.type === 'Dialog.ScrollArea').props.style
      .backgroundColor,
    theme.colors.surface,
  );
  for (const n of nodes(h.tree).filter(
    n => n.type === 'TextInput' || n.type === 'Text',
  ))
    assert.equal(n.props.theme, theme);
});
test('changing to light theme updates the control surface rather than a fixed white/dark fill', async () => {
  theme = {
    dark: false,
    colors: {
      background: '#ffffff',
      surface: '#fafafa',
      surfaceVariant: '#e8e8e8',
      onSurface: '#000000',
      onSurfaceVariant: '#111111',
    },
  };
  h.dirty = true;
  await flush();
  assert.equal(
    byId('conversation-controls-surface').props.style.backgroundColor,
    theme.colors.background,
  );
});
test('new-chat preference transfer refreshes the visible memory label', async () => {
  await storage.savePreferences('chat-1', {
    version: 1,
    useMemories: true,
    autoCompact: true,
  });
  h.dirty = true;
  await flush();
  assert.ok(
    byId('conversation-options').props.children.includes(
      'Memories: on · Context',
    ),
  );
});
test('memory switch writes do not reset unsaved model form text', async () => {
  stores.modelStore.activeModel = {
    id: 'm1',
    origin: 'local',
    chatTemplate: {systemPrompt: ''},
  };
  h.dirty = true;
  await flush();
  await open();
  input('Model system prompt').props.onChangeText('Unsaved model prompt');
  await flush();
  await byId('use-memories-switch').props.onValueChange(true);
  await flush();
  assert.equal(
    input('Model system prompt').props.value,
    'Unsaved model prompt',
  );
});
