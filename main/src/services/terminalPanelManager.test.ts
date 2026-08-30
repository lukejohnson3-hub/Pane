import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigManager } from './configManager';
import { resetPaneRuntimeForTests, setPaneRuntime } from '../core/runtime';
import { createFlowControlRecord, disposeFlowControlRecord, type FlowControlRecord } from '../ptyHost/flowControl';
import { TerminalStateEmulator } from './terminalStateEmulator';
import type { TerminalPanelState } from '../../../shared/types/panels';

import { MAX_LIVE_TERMINALS, TERMINAL_IDLE_SUSPEND_MS, TerminalPanelManager } from './terminalPanelManager';
import { panelManager } from '../test/setup';

vi.spyOn(panelManager, 'emitPanelEvent');
vi.spyOn(panelManager, 'getPanel');
vi.spyOn(panelManager, 'updatePanel');

type TerminalUnderTest = {
  pty: {
    cols: number;
    rows: number;
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
  };
  isPtyHost: boolean;
  panelId: string;
  sessionId: string;
  scrollbackBuffer: string;
  alternateScreenBuffer: string;
  screenEmulator?: TerminalStateEmulator;
  commandHistory: string[];
  currentCommand: string;
  lastActivity: Date;
  lastOutputAt?: Date;
  outputGeneration: number;
  wslContext: null;
  flowControl: FlowControlRecord;
  outputBuffer: string;
  outputFlushTimer: ReturnType<typeof setTimeout> | null;
  isVisible: boolean;
  isWSL?: boolean;
  isAlternateScreen: boolean;
  inSyncBlock: boolean;
  agentType?: 'claude' | 'codex' | 'cursor';
  agentSessionScrapeBuffer: string;
  capturedAgentSessionId?: string;
};

type FlushOutputBufferAccess = {
  flushOutputBuffer(terminal: TerminalUnderTest): void;
};

type VisibilityAccess = {
  terminals: Map<string, TerminalUnderTest>;
  setVisibility(panelId: string, isVisible: boolean, viewerId?: string): void;
  clearVisibilityViewersByPrefix(prefix: string): void;
  pruneVisibilityViewersByPrefix(prefix: string, staleAfterMs: number): void;
};

type SnapshotAccess = {
  terminals: Map<string, TerminalUnderTest>;
  getTerminalSnapshot(panelId: string): ReturnType<TerminalPanelManager['getTerminalSnapshot']>;
  getTerminalState(panelId: string): ReturnType<TerminalPanelManager['getTerminalState']>;
};

type ResizeAccess = {
  terminals: Map<string, TerminalUnderTest>;
  resizeTerminal(
    panelId: string,
    cols: number,
    rows: number,
    options?: { force?: boolean },
  ): Promise<void>;
};

type InitialInputAccess = {
  terminals: Map<string, TerminalUnderTest>;
  sendInitialInputOnce(panelId: string): void;
  deliverPendingInitialInput(panelId: string): void;
  getLastOutputAt(panelId: string): string | undefined;
  getOutputGeneration(panelId: string): number;
};

type LaunchCommandAccess = {
  resolveCliLaunchCommand(panelId: string, initialCommand: string, customState: TerminalPanelState, shellType?: string): {
    commandToRun: string;
    customState: TerminalPanelState;
    isCliCommand: boolean;
  };
};

type AgentSessionCaptureAccess = {
  terminals: Map<string, TerminalUnderTest>;
  captureAgentSessionId(terminal: TerminalUnderTest, output: string): void;
  saveTerminalState(panelId: string): Promise<void>;
};

type SuspendIdleAccess = {
  terminals: Map<string, TerminalUnderTest>;
  agentStatusMonitor: { getState(panelId: string): string | undefined };
  suspendIdleTerminals(now?: number): void;
  flushOutputBuffer(terminal: TerminalUnderTest): void;
  setVisibility(panelId: string, isVisible: boolean, viewerId?: string): void;
  destroyAllTerminals(): void;
  saveSerializedSnapshot(panelId: string, serializedData: string): void;
  visibleViewersByPanel: Map<string, Map<string, number>>;
  serializedBuffers: Map<string, string>;
  sessionLastVisibleAt: Map<string, number>;
};

type ShellPromptSchedulerAccess = {
  scheduleAfterShellPrompt(ptyProcess: TerminalUnderTest['pty'] & {
    onData(listener: (data: string) => void): { dispose(): void };
  }, callback: () => void): void;
};

function testAccess<Access>(manager: TerminalPanelManager): Access {
  // SAFETY: Each access type above mirrors the exact members exercised by its
  // tests, private ones included; this helper keeps that test-only seam in one
  // place.
  return manager as Access;
}

function partialMock<Contract>(implementation: Partial<Contract>): Contract {
  // SAFETY: Each test stub implements every ConfigManager member reached by
  // the scenario; an unexpected call fails immediately instead of escaping.
  return implementation as Contract;
}

function createTerminal(overrides: Partial<TerminalUnderTest> = {}): TerminalUnderTest {
  return {
    pty: {
      cols: 80,
      rows: 24,
      pause: vi.fn(),
      resume: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
    },
    isPtyHost: false,
    panelId: 'panel-1',
    sessionId: 'session-1',
    scrollbackBuffer: '',
    alternateScreenBuffer: '',
    commandHistory: [],
    currentCommand: '',
    lastActivity: new Date(),
    outputGeneration: 0,
    wslContext: null,
    flowControl: createFlowControlRecord(),
    outputBuffer: 'hello from terminal',
    outputFlushTimer: null,
    isVisible: true,
    isAlternateScreen: false,
    inSyncBlock: false,
    agentSessionScrapeBuffer: '',
    ...overrides,
  };
}

describe('TerminalPanelManager terminal resize', () => {
  afterEach(() => {
    vi.mocked(panelManager.getPanel).mockReset();
    vi.mocked(panelManager.updatePanel).mockReset();
    vi.useRealTimers();
  });

  it('deduplicates ordinary same-size resizes but holds an actual redraw transition', async () => {
    vi.useFakeTimers();
    const manager = testAccess<ResizeAccess>(new TerminalPanelManager());
    const terminal = createTerminal({ outputBuffer: '' });
    manager.terminals.set(terminal.panelId, terminal);

    await manager.resizeTerminal(terminal.panelId, 80, 24);
    expect(terminal.pty.resize).not.toHaveBeenCalled();

    const redraw = manager.resizeTerminal(terminal.panelId, 80, 24, { force: true });
    expect(terminal.pty.resize).toHaveBeenNthCalledWith(1, 80, 23);
    expect(terminal.pty.resize).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    await redraw;
    expect(terminal.pty.resize).toHaveBeenNthCalledWith(2, 80, 24);
    disposeFlowControlRecord(terminal.flowControl);
  });
});

describe('TerminalPanelManager shell prompt scheduling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createPromptPty() {
    let listener: ((data: string) => void) | undefined;
    const dispose = vi.fn();
    const terminal = createTerminal();
    return {
      pty: {
        ...terminal.pty,
        onData: vi.fn((nextListener: (data: string) => void) => {
          listener = nextListener;
          return { dispose };
        }),
      },
      emit(data: string) {
        listener?.(data);
      },
      dispose,
    };
  }

  it('waits for the shell to settle after detecting its prompt', async () => {
    vi.useFakeTimers();
    const manager = testAccess<ShellPromptSchedulerAccess>(new TerminalPanelManager());
    const promptPty = createPromptPty();
    const callback = vi.fn();

    manager.scheduleAfterShellPrompt(promptPty.pty, callback);
    promptPty.emit('user@host:~$ ');

    await vi.advanceTimersByTimeAsync(299);
    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(promptPty.dispose).toHaveBeenCalledTimes(1);
  });

  it('invokes once when repeated prompts race the fallback', async () => {
    vi.useFakeTimers();
    const manager = testAccess<ShellPromptSchedulerAccess>(new TerminalPanelManager());
    const promptPty = createPromptPty();
    const callback = vi.fn();

    manager.scheduleAfterShellPrompt(promptPty.pty, callback);
    promptPty.emit('\x1b[32m$\x1b[0m ');
    promptPty.emit('\x1b[32m$\x1b[0m ');

    await vi.runAllTimersAsync();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(promptPty.dispose).toHaveBeenCalledTimes(1);
  });

  it('falls back after five seconds when no prompt is detected', async () => {
    vi.useFakeTimers();
    const manager = testAccess<ShellPromptSchedulerAccess>(new TerminalPanelManager());
    const promptPty = createPromptPty();
    const callback = vi.fn();

    manager.scheduleAfterShellPrompt(promptPty.pty, callback);
    promptPty.emit('loading shell configuration\r\n');

    await vi.advanceTimersByTimeAsync(4999);
    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

function createConfigManagerStub(): ConfigManager {
  return partialMock<ConfigManager>({
    getUsePtyHost: () => false,
  });
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('TerminalPanelManager hidden output delivery', () => {
  afterEach(() => {
    resetPaneRuntimeForTests();
    vi.mocked(panelManager.getPanel).mockReset();
    vi.mocked(panelManager.updatePanel).mockReset();
    vi.useRealTimers();
  });

  it('keeps visible terminal output on the combined runtime sink', () => {
    const combinedSink = { send: vi.fn() };
    const daemonSink = { send: vi.fn() };
    setPaneRuntime({
      eventSink: combinedSink,
      daemonEventSink: daemonSink,
      getConfigManager: () => createConfigManagerStub(),
      getPtyHostRuntime: () => null,
      getWebviewContextMap: () => new Map(),
    });

    const manager = new TerminalPanelManager();
    const terminal = createTerminal();

    testAccess<FlushOutputBufferAccess>(manager).flushOutputBuffer(terminal);

    expect(combinedSink.send).toHaveBeenCalledWith('terminal:output', {
      sessionId: 'session-1',
      panelId: 'panel-1',
      output: 'hello from terminal',
    });
    expect(daemonSink.send).not.toHaveBeenCalled();
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('sends hidden terminal output to daemon subscribers without waking the renderer sink', () => {
    const combinedSink = { send: vi.fn() };
    const daemonSink = { send: vi.fn() };
    setPaneRuntime({
      eventSink: combinedSink,
      daemonEventSink: daemonSink,
      getConfigManager: () => createConfigManagerStub(),
      getPtyHostRuntime: () => null,
      getWebviewContextMap: () => new Map(),
    });

    const manager = new TerminalPanelManager();
    const terminal = createTerminal({ isVisible: false });

    testAccess<FlushOutputBufferAccess>(manager).flushOutputBuffer(terminal);

    expect(combinedSink.send).not.toHaveBeenCalled();
    expect(daemonSink.send).toHaveBeenCalledWith('terminal:output', {
      sessionId: 'session-1',
      panelId: 'panel-1',
      output: 'hello from terminal',
    });
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('flushes pending hidden output to daemon subscribers before making a panel visible', () => {
    const combinedSink = { send: vi.fn() };
    const daemonSink = { send: vi.fn() };
    setPaneRuntime({
      eventSink: combinedSink,
      daemonEventSink: daemonSink,
      getConfigManager: () => createConfigManagerStub(),
      getPtyHostRuntime: () => null,
      getWebviewContextMap: () => new Map(),
    });

    const manager = testAccess<VisibilityAccess>(new TerminalPanelManager());
    const terminal = createTerminal({
      isVisible: false,
      outputBuffer: 'hidden output',
      outputFlushTimer: setTimeout(() => undefined, 10_000),
    });
    manager.terminals.set(terminal.panelId, terminal);

    manager.setVisibility(terminal.panelId, true);

    expect(combinedSink.send).not.toHaveBeenCalled();
    expect(daemonSink.send).toHaveBeenCalledWith('terminal:output', {
      sessionId: 'session-1',
      panelId: 'panel-1',
      output: 'hidden output',
    });
    expect(terminal.outputBuffer).toBe('');
    expect(terminal.outputFlushTimer).toBeNull();
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('flushes buffered output to daemon subscribers before hiding a visible panel', () => {
    const combinedSink = { send: vi.fn() };
    const daemonSink = { send: vi.fn() };
    setPaneRuntime({
      eventSink: combinedSink,
      daemonEventSink: daemonSink,
      getConfigManager: () => createConfigManagerStub(),
      getPtyHostRuntime: () => null,
      getWebviewContextMap: () => new Map(),
    });

    const manager = testAccess<VisibilityAccess>(new TerminalPanelManager());
    const terminal = createTerminal({
      isVisible: true,
      outputBuffer: 'visible output',
      outputFlushTimer: setTimeout(() => undefined, 10_000),
    });
    manager.terminals.set(terminal.panelId, terminal);

    manager.setVisibility(terminal.panelId, false);

    expect(combinedSink.send).not.toHaveBeenCalled();
    expect(daemonSink.send).toHaveBeenCalledWith('terminal:output', {
      sessionId: 'session-1',
      panelId: 'panel-1',
      output: 'visible output',
    });
    expect(terminal.outputBuffer).toBe('');
    expect(terminal.outputFlushTimer).toBeNull();
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('keeps terminal visible until the last visible viewer hides', () => {
    const combinedSink = { send: vi.fn() };
    const daemonSink = { send: vi.fn() };
    setPaneRuntime({
      eventSink: combinedSink,
      daemonEventSink: daemonSink,
      getConfigManager: () => createConfigManagerStub(),
      getPtyHostRuntime: () => null,
      getWebviewContextMap: () => new Map(),
    });

    const manager = testAccess<VisibilityAccess>(new TerminalPanelManager());
    const terminal = createTerminal({
      isVisible: false,
      outputBuffer: '',
    });
    manager.terminals.set(terminal.panelId, terminal);

    manager.setVisibility(terminal.panelId, true, 'local:host');
    manager.setVisibility(terminal.panelId, true, 'remote:mac');
    manager.setVisibility(terminal.panelId, false, 'remote:mac');

    expect(terminal.isVisible).toBe(true);

    manager.setVisibility(terminal.panelId, false, 'local:host');

    expect(terminal.isVisible).toBe(false);
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('clears remote viewer visibility by prefix on disconnect', () => {
    const manager = testAccess<VisibilityAccess>(new TerminalPanelManager());
    const terminal = createTerminal({
      isVisible: false,
      outputBuffer: '',
    });
    manager.terminals.set(terminal.panelId, terminal);

    manager.setVisibility(terminal.panelId, true, 'local:host');
    manager.setVisibility(terminal.panelId, true, 'remote:client-1:runtime-1:viewer:a');
    manager.clearVisibilityViewersByPrefix('remote:client-1:runtime-1');

    expect(terminal.isVisible).toBe(true);

    manager.setVisibility(terminal.panelId, false, 'local:host');

    expect(terminal.isVisible).toBe(false);
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('returns emulated live screen and restore state for daemon and renderer reads', async () => {
    const manager = testAccess<SnapshotAccess>(new TerminalPanelManager());
    const screenEmulator = new TerminalStateEmulator(40, 5);
    screenEmulator.write('\x1b[?1049h\x1b[Hagent screen');
    await screenEmulator.waitForIdle();
    const terminal = createTerminal({
      scrollbackBuffer: 'scrollback',
      alternateScreenBuffer: 'screen',
      screenEmulator,
      isAlternateScreen: true,
      currentCommand: 'codex',
      capturedAgentSessionId: 'agent-session-1',
    });
    manager.terminals.set(terminal.panelId, terminal);
    vi.mocked(panelManager.getPanel).mockReturnValue({
      id: terminal.panelId,
      sessionId: terminal.sessionId,
      type: 'terminal',
      title: 'Codex',
      state: {
        isActive: true,
        customState: {
          isCliPanel: true,
          isCliReady: true,
          agentType: 'codex',
        },
      },
      metadata: {
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:01:00.000Z',
        position: 0,
      },
    });

    const snapshot = manager.getTerminalSnapshot(terminal.panelId);

    expect(snapshot).toMatchObject({
      initialized: true,
      scrollbackBuffer: 'scrollback',
      alternateScreenBuffer: 'screen',
      screenText: 'agent screen',
      isAlternateScreen: true,
      activityStatus: 'idle',
      currentCommand: 'codex',
      isCliPanel: true,
      isCliReady: true,
      agentType: 'codex',
      agentSessionId: 'agent-session-1',
    });
    const restoreState = await manager.getTerminalState(terminal.panelId);
    expect(restoreState).toMatchObject({
      isAlternateScreen: true,
      scrollbackBuffer: 'scrollback',
    });
    expect(restoreState?.serializedBuffer).toContain('\x1b[?1049h');
    screenEmulator.dispose();
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('serves normal-buffer restore content from the rendered emulator, not the raw append log', async () => {
    const manager = testAccess<SnapshotAccess>(new TerminalPanelManager());
    const screenEmulator = new TerminalStateEmulator(40, 5);
    const frame = 'PR #363 state unchanged';
    // Live stream: the frame prints once, then forced-redraw repaints re-emit it
    // after cursor-home — the traffic that duplicated rows when the raw log was
    // replayed. The emulator overwrites in place, like a live terminal.
    const initial = `${frame}\r\n`;
    const repaint = `\x1b[H${frame}\x1b[K\r\n`;
    screenEmulator.write(initial);
    screenEmulator.write(repaint);
    screenEmulator.write(repaint);
    await screenEmulator.waitForIdle();
    const terminal = createTerminal({
      scrollbackBuffer: initial + repaint + repaint,
      screenEmulator,
      isAlternateScreen: false,
    });
    manager.terminals.set(terminal.panelId, terminal);

    const restoreState = await manager.getTerminalState(terminal.panelId);
    const restored = restoreState?.scrollbackBuffer;
    expect(restored).toBeDefined();
    if (restored === undefined) throw new Error('Expected restored scrollback');
    expect(restored.split(frame).length - 1).toBe(1);
    expect(terminal.scrollbackBuffer.split(frame).length - 1).toBe(3);
    screenEmulator.dispose();
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('submits Codex initial input through the composer sequence', async () => {
    vi.useFakeTimers();
    const manager = testAccess<InitialInputAccess>(new TerminalPanelManager());
    const terminal = createTerminal();
    manager.terminals.set(terminal.panelId, terminal);
    const panel = {
      id: terminal.panelId,
      sessionId: terminal.sessionId,
      type: 'terminal' as const,
      title: 'Codex',
      state: {
        isActive: true,
        customState: {
          initialInput: 'Read the Pane Chat guide and initialize yourself.',
          initialInputSubmitStrategy: 'codex-ctrl-enter' as const,
          agentType: 'codex' as const,
        },
      },
      metadata: {
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:01:00.000Z',
        position: 0,
      },
    };
    vi.mocked(panelManager.getPanel).mockReturnValue(panel);

    manager.sendInitialInputOnce(terminal.panelId);
    await flushPromises();

    expect(terminal.pty.write).toHaveBeenCalledWith('Read the Pane Chat guide and initialize yourself.');
    expect(terminal.pty.write).not.toHaveBeenCalledWith('\x1b[13;5u\r');

    await vi.advanceTimersByTimeAsync(500);

    expect(terminal.pty.write).toHaveBeenCalledWith('\x1b[13;5u\r');
    expect(panelManager.updatePanel).toHaveBeenCalledWith(terminal.panelId, {
      state: expect.objectContaining({
        customState: expect.objectContaining({
          initialInputSentAt: expect.any(String),
          initialInputError: undefined,
        }),
      }),
    });
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('does not treat input writes as output freshness', () => {
    const manager = testAccess<InitialInputAccess & TerminalPanelManager>(new TerminalPanelManager());
    const terminal = createTerminal();
    manager.terminals.set(terminal.panelId, terminal);

    manager.writeToTerminal(terminal.panelId, 'typed input');

    expect(terminal.pty.write).toHaveBeenCalledWith('typed input');
    expect(manager.getLastOutputAt(terminal.panelId)).toBeUndefined();
    expect(manager.getOutputGeneration(terminal.panelId)).toBe(0);
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('delivers pending ready initial input with the panel submit strategy', async () => {
    vi.useFakeTimers();
    const manager = testAccess<InitialInputAccess>(new TerminalPanelManager());
    const terminal = createTerminal();
    manager.terminals.set(terminal.panelId, terminal);
    vi.mocked(panelManager.getPanel).mockReturnValue({
      id: terminal.panelId,
      sessionId: terminal.sessionId,
      type: 'terminal',
      title: 'Codex',
      state: {
        isActive: true,
        customState: {
          isCliReady: true,
          initialInput: '/do TM-x',
          initialInputSubmitStrategy: 'codex-ctrl-enter' as const,
        },
      },
      metadata: {
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:01:00.000Z',
        position: 0,
      },
    });

    manager.deliverPendingInitialInput(terminal.panelId);
    await flushPromises();

    expect(terminal.pty.write).toHaveBeenCalledTimes(1);
    expect(terminal.pty.write).toHaveBeenNthCalledWith(1, '/do TM-x');

    await vi.advanceTimersByTimeAsync(500);

    expect(terminal.pty.write).toHaveBeenCalledTimes(2);
    expect(terminal.pty.write).toHaveBeenNthCalledWith(2, '\x1b[13;5u\r');
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('delivers after a premark clear when the cliReady path already skipped', async () => {
    const manager = testAccess<InitialInputAccess>(new TerminalPanelManager());
    const terminal = createTerminal();
    manager.terminals.set(terminal.panelId, terminal);
    const panel = {
      id: terminal.panelId,
      sessionId: terminal.sessionId,
      type: 'terminal' as const,
      title: 'Codex',
      state: {
        isActive: true,
        customState: {
          isCliReady: true,
          initialInput: '/do TM-x',
          initialInputSentAt: '2026-01-01T00:02:00.000Z',
          initialInputSubmitStrategy: 'enter' as const,
        },
      },
      metadata: {
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:01:00.000Z',
        position: 0,
      },
    };
    vi.mocked(panelManager.getPanel).mockReturnValue(panel);

    manager.sendInitialInputOnce(terminal.panelId);
    await flushPromises();

    expect(terminal.pty.write).not.toHaveBeenCalled();
    delete panel.state.customState.initialInputSentAt;

    manager.deliverPendingInitialInput(terminal.panelId);
    await flushPromises();

    expect(terminal.pty.write).toHaveBeenCalledTimes(1);
    expect(terminal.pty.write).toHaveBeenCalledWith('/do TM-x\r');
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('delivers initial input exactly once when cliReady and explicit triggers race', async () => {
    const manager = testAccess<InitialInputAccess>(new TerminalPanelManager());
    const terminal = createTerminal();
    manager.terminals.set(terminal.panelId, terminal);
    const panel = {
      id: terminal.panelId,
      sessionId: terminal.sessionId,
      type: 'terminal' as const,
      title: 'Codex',
      state: {
        isActive: true,
        customState: {
          isCliReady: true,
          initialInput: '/do TM-x',
          initialInputSubmitStrategy: 'enter' as const,
        },
      },
      metadata: {
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:01:00.000Z',
        position: 0,
      },
    };
    vi.mocked(panelManager.getPanel).mockReturnValue(panel);

    manager.sendInitialInputOnce(terminal.panelId);
    manager.deliverPendingInitialInput(terminal.panelId);
    await flushPromises();

    expect(terminal.pty.write).toHaveBeenCalledTimes(1);
    expect(terminal.pty.write).toHaveBeenCalledWith('/do TM-x\r');
    expect(panelManager.updatePanel).toHaveBeenCalledTimes(1);
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('passes fresh Codex initial input as a startup prompt argument', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());

    const result = manager.resolveCliLaunchCommand('panel-1', 'codex --yolo', {
      agentType: 'codex',
      initialInputMode: 'argument',
      initialInput: 'Read "the guide" and initialize `Pane Chat`.',
    });

    expect(result).toMatchObject({
      commandToRun: 'codex --yolo "Read \\"the guide\\" and initialize \\`Pane Chat\\`."',
      isCliCommand: true,
      customState: {
        agentType: 'codex',
        isCliPanel: true,
        isCliReady: false,
        initialInputSentAt: expect.any(String),
        initialInputError: undefined,
      },
    });
  });

  it('escapes shell-sensitive startup prompt arguments without changing ordinary prompts', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());
    const unsafeCommandSubstitution = manager.resolveCliLaunchCommand('panel-1', 'codex --yolo', {
      agentType: 'codex',
      initialInputMode: 'argument',
      initialInput: 'BACKSLASH\\$(touch /tmp/pwned)',
    });
    const escapedShellSyntax = manager.resolveCliLaunchCommand('panel-2', 'codex --yolo', {
      agentType: 'codex',
      initialInputMode: 'argument',
      initialInput: 'plain $value and `cmd`',
    });
    const ordinaryPrompt = manager.resolveCliLaunchCommand('panel-3', 'codex --yolo', {
      agentType: 'codex',
      initialInputMode: 'argument',
      initialInput: 'Read the guide and initialize Pane Chat.',
    });

    expect(unsafeCommandSubstitution.commandToRun).toBe('codex --yolo "BACKSLASH\\\\\\$(touch /tmp/pwned)"');
    expect(unsafeCommandSubstitution.commandToRun).not.toMatch(/(^|[^\\])(?:\\\\)*\$\(/);
    expect(escapedShellSyntax.commandToRun).toBe('codex --yolo "plain \\$value and \\`cmd\\`"');
    expect(ordinaryPrompt.commandToRun).toBe('codex --yolo "Read the guide and initialize Pane Chat."');
  });

  it('passes fresh Claude slash input as a quoted startup argument', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());

    const result = manager.resolveCliLaunchCommand(
      '11111111-1111-4111-8111-111111111111',
      'claude --dangerously-skip-permissions',
      {
        agentType: 'claude',
        initialInputMode: 'argument',
        initialInput: '/do TM-x',
      },
    );

    expect(result).toMatchObject({
      commandToRun: 'claude --dangerously-skip-permissions --session-id 11111111-1111-4111-8111-111111111111 "/do TM-x"',
      isCliCommand: true,
      customState: {
        initialInputSentAt: expect.any(String),
        initialInputError: undefined,
      },
    });
  });

  it('preserves multiline Claude input in the quoted startup argument', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());
    const input = 'First line\nSecond line with $value';

    const result = manager.resolveCliLaunchCommand(
      '11111111-1111-4111-8111-111111111111',
      'claude --dangerously-skip-permissions',
      {
        agentType: 'claude',
        initialInputMode: 'argument',
        initialInput: input,
      },
    );

    expect(result.commandToRun).toBe(
      'claude --dangerously-skip-permissions --session-id 11111111-1111-4111-8111-111111111111 "First line\nSecond line with \\$value"',
    );
    expect(result.customState.initialInputSentAt).toEqual(expect.any(String));
  });

  it('keeps resumed Claude input composer-bound', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());

    const result = manager.resolveCliLaunchCommand(
      '11111111-1111-4111-8111-111111111111',
      'claude --dangerously-skip-permissions',
      {
        agentType: 'claude',
        hasClaudeSessionId: true,
        agentSessionId: '22222222-2222-4222-8222-222222222222',
        initialInputMode: 'argument',
        initialInput: '/do TM-x',
      },
    );

    expect(result.commandToRun).toBe(
      'claude --resume 22222222-2222-4222-8222-222222222222 --dangerously-skip-permissions',
    );
    expect(result.customState).not.toHaveProperty('initialInputSentAt');
  });

  it('launches a fresh Cursor panel through the create-chat compound', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());

    const result = manager.resolveCliLaunchCommand('panel-1', 'cursor-agent --force --trust', {
      agentType: 'cursor',
    });

    expect(result).toMatchObject({
      commandToRun:
        'if __PANE_CURSOR_CHAT="$(cursor-agent create-chat 2>/dev/null)" && [ -n "$__PANE_CURSOR_CHAT" ]; '
        + 'then printf \'\\npane-cursor-chat-id: %s\\n\' "$__PANE_CURSOR_CHAT"; '
        + 'cursor-agent --force --trust --resume "$__PANE_CURSOR_CHAT"; '
        + 'else cursor-agent --force --trust; fi',
      isCliCommand: true,
      customState: {
        agentType: 'cursor',
        isCliPanel: true,
        isCliReady: false,
      },
    });
  });

  it('passes fresh Cursor initial input as a startup prompt argument on both compound branches', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());

    const result = manager.resolveCliLaunchCommand('panel-1', 'cursor-agent --force --trust', {
      agentType: 'cursor',
      initialInputMode: 'argument',
      initialInput: 'Read "the guide" and initialize `Pane Chat`.',
    });

    const quoted = '"Read \\"the guide\\" and initialize \\`Pane Chat\\`."';
    expect(result.commandToRun).toContain(`--resume "$__PANE_CURSOR_CHAT" ${quoted}; `);
    expect(result.commandToRun).toContain(`else cursor-agent --force --trust ${quoted}; fi`);
    expect(result.customState).toMatchObject({
      agentType: 'cursor',
      initialInputSentAt: expect.any(String),
      initialInputError: undefined,
    });
  });

  it('uses fish-compatible syntax for a fresh Cursor launch in fish', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());

    const result = manager.resolveCliLaunchCommand('panel-1', 'cursor-agent --force --trust', {
      agentType: 'cursor',
    }, 'fish');

    expect(result.commandToRun).toBe(
      'if set __PANE_CURSOR_CHAT (cursor-agent create-chat 2>/dev/null); and test -n "$__PANE_CURSOR_CHAT"; '
      + 'printf \'\\npane-cursor-chat-id: %s\\n\' "$__PANE_CURSOR_CHAT"; '
      + 'cursor-agent --force --trust --resume "$__PANE_CURSOR_CHAT"; '
      + 'else; cursor-agent --force --trust; end',
    );
  });

  it('resumes an interrupted Cursor panel with its captured chat id', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());

    const result = manager.resolveCliLaunchCommand('panel-1', 'cursor-agent --force --trust', {
      agentType: 'cursor',
      wasInterrupted: true,
      agentSessionId: '7403f755-6758-40d3-bb69-2cd356dd9bf0',
    });

    expect(result).toMatchObject({
      commandToRun: 'cursor-agent --force --trust --resume "7403f755-6758-40d3-bb69-2cd356dd9bf0"',
      isCliCommand: true,
      customState: {
        agentType: 'cursor',
        wasInterrupted: undefined,
      },
    });
  });

  it('continues the latest Cursor chat when an interrupted panel has no captured id', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());

    const result = manager.resolveCliLaunchCommand('panel-1', 'cursor-agent --force --trust', {
      agentType: 'cursor',
      wasInterrupted: true,
    });

    expect(result).toMatchObject({
      commandToRun: 'cursor-agent --force --trust --continue',
      isCliCommand: true,
      customState: {
        wasInterrupted: undefined,
      },
    });
  });

  it('keeps Enter as the default initial input submit strategy', async () => {
    const manager = testAccess<InitialInputAccess>(new TerminalPanelManager());
    const terminal = createTerminal();
    manager.terminals.set(terminal.panelId, terminal);
    vi.mocked(panelManager.getPanel).mockReturnValue({
      id: terminal.panelId,
      sessionId: terminal.sessionId,
      type: 'terminal',
      title: 'Tool',
      state: {
        isActive: true,
        customState: {
          initialInput: 'hello tool',
        },
      },
      metadata: {
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:01:00.000Z',
        position: 0,
      },
    });

    manager.sendInitialInputOnce(terminal.panelId);
    await flushPromises();

    expect(terminal.pty.write).toHaveBeenCalledWith('hello tool\r');
    disposeFlowControlRecord(terminal.flowControl);
  });
});

describe('TerminalPanelManager agent session capture', () => {
  const CURSOR_CHAT_ID = '7403f755-6758-40d3-bb69-2cd356dd9bf0';

  afterEach(() => {
    vi.mocked(panelManager.getPanel).mockReset();
    vi.mocked(panelManager.updatePanel).mockReset();
  });

  const mockPanel = (agentType: string, initialCommand: string, panelId = 'panel-1') => {
    vi.mocked(panelManager.updatePanel).mockResolvedValue(undefined);
    vi.mocked(panelManager.getPanel).mockReturnValue({
      id: panelId,
      sessionId: 'session-1',
      type: 'terminal',
      title: 'Agent',
      state: {
        isActive: true,
        customState: { agentType, initialCommand, isCliPanel: true },
      },
      metadata: {
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:01:00.000Z',
        position: 0,
      },
    });
  };

  it('persists the Cursor chat id scraped from the marker line', () => {
    const manager = testAccess<AgentSessionCaptureAccess>(new TerminalPanelManager());
    const terminal = createTerminal({ agentType: 'cursor' });
    mockPanel('cursor', 'cursor-agent --force --trust');

    manager.captureAgentSessionId(terminal, `\r\npane-cursor-chat-id: ${CURSOR_CHAT_ID}\r\n`);

    expect(terminal.capturedAgentSessionId).toBe(CURSOR_CHAT_ID);
    expect(panelManager.updatePanel).toHaveBeenCalledWith('panel-1', {
      state: expect.objectContaining({
        customState: expect.objectContaining({ agentType: 'cursor', agentSessionId: CURSOR_CHAT_ID }),
      }),
    });
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('still captures Codex resume ids from screen output', () => {
    const manager = testAccess<AgentSessionCaptureAccess>(new TerminalPanelManager());
    const terminal = createTerminal({ agentType: 'codex' });
    mockPanel('codex', 'codex --yolo');

    manager.captureAgentSessionId(terminal, `To continue, run codex resume ${CURSOR_CHAT_ID}\r\n`);

    expect(terminal.capturedAgentSessionId).toBe(CURSOR_CHAT_ID);
    expect(panelManager.updatePanel).toHaveBeenCalledWith('panel-1', {
      state: expect.objectContaining({
        customState: expect.objectContaining({ agentType: 'codex', agentSessionId: CURSOR_CHAT_ID }),
      }),
    });
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('ignores marker lines when the panel is not a cursor panel', () => {
    const manager = testAccess<AgentSessionCaptureAccess>(new TerminalPanelManager());
    const terminal = createTerminal({ agentType: 'codex' });
    mockPanel('codex', 'codex --yolo');

    manager.captureAgentSessionId(terminal, `pane-cursor-chat-id: ${CURSOR_CHAT_ID}\r\n`);

    expect(terminal.capturedAgentSessionId).toBeUndefined();
    expect(panelManager.updatePanel).not.toHaveBeenCalled();
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('persists the captured session id for the terminal agent on state save', async () => {
    const manager = testAccess<AgentSessionCaptureAccess>(new TerminalPanelManager());
    const terminal = createTerminal({ agentType: 'cursor', capturedAgentSessionId: CURSOR_CHAT_ID });
    manager.terminals.set(terminal.panelId, terminal);
    mockPanel('cursor', 'cursor-agent --force --trust');

    await manager.saveTerminalState(terminal.panelId);

    expect(panelManager.updatePanel).toHaveBeenCalledWith(terminal.panelId, {
      state: expect.objectContaining({
        customState: expect.objectContaining({ agentType: 'cursor', agentSessionId: CURSOR_CHAT_ID }),
      }),
    });
    disposeFlowControlRecord(terminal.flowControl);
  });
});

describe('TerminalPanelManager live-terminal ceiling', () => {
  // Real clock: the session pin is recorded with Date.now() inside
  // applyVisibilityState, so the assertions have to share that timebase.
  const NOW = Date.now();

  afterEach(() => {
    vi.mocked(panelManager.getPanel).mockReset();
    vi.mocked(panelManager.updatePanel).mockReset();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /**
   * Fills the manager with terminals that all satisfy every guard, so a test can
   * knock out exactly one condition and watch it protect that panel. Idleness
   * grows with the index, so the highest index is always the first candidate.
   */
  function fill(
    manager: SuspendIdleAccess,
    count: number,
    overridesFor: (index: number) => Partial<TerminalUnderTest> = () => ({}),
  ): void {
    for (let i = 0; i < count; i++) {
      const panelId = `panel-${i}`;
      manager.terminals.set(panelId, createTerminal({
        panelId,
        sessionId: `session-${i}`,
        isVisible: false,
        lastActivity: new Date(NOW - TERMINAL_IDLE_SUSPEND_MS - 1000 - i),
        ...overridesFor(i),
      }));
    }
  }

  function stubAgentStates(manager: SuspendIdleAccess, byPanel: Record<string, string> = {}): void {
    vi.spyOn(manager.agentStatusMonitor, 'getState').mockImplementation(
      (panelId: string) => byPanel[panelId] ?? 'idle',
    );
  }

  it('leaves every terminal alone below the ceiling', () => {
    const manager = testAccess<SuspendIdleAccess>(new TerminalPanelManager());
    fill(manager, MAX_LIVE_TERMINALS - 1);
    stubAgentStates(manager);

    manager.suspendIdleTerminals(NOW);

    expect(manager.terminals.size).toBe(MAX_LIVE_TERMINALS - 1);
  });

  it('kills the PTY of the longest-idle terminal, and only enough to get back under', () => {
    const manager = testAccess<SuspendIdleAccess>(new TerminalPanelManager());
    fill(manager, MAX_LIVE_TERMINALS);
    stubAgentStates(manager);
    const oldest = manager.terminals.get(`panel-${MAX_LIVE_TERMINALS - 1}`);
    const survivor = manager.terminals.get('panel-0');

    manager.suspendIdleTerminals(NOW);

    expect(manager.terminals.has(`panel-${MAX_LIVE_TERMINALS - 1}`)).toBe(false);
    // Dropping it from the map is not enough — the process has to actually die.
    expect(oldest?.pty.kill).toHaveBeenCalled();
    expect(survivor?.pty.kill).not.toHaveBeenCalled();
    expect(manager.terminals.size).toBe(MAX_LIVE_TERMINALS - 1);
  });

  it('never suspends a visible terminal or a working or blocked agent', () => {
    const manager = testAccess<SuspendIdleAccess>(new TerminalPanelManager());
    const visible = `panel-${MAX_LIVE_TERMINALS - 1}`;
    const working = `panel-${MAX_LIVE_TERMINALS - 2}`;
    const blocked = `panel-${MAX_LIVE_TERMINALS - 3}`;
    fill(manager, MAX_LIVE_TERMINALS, (i) => (i === MAX_LIVE_TERMINALS - 1 ? { isVisible: true } : {}));
    stubAgentStates(manager, { [working]: 'working', [blocked]: 'blocked' });

    manager.suspendIdleTerminals(NOW);

    expect(manager.terminals.has(visible)).toBe(true);
    expect(manager.terminals.has(working)).toBe(true);
    expect(manager.terminals.has(blocked)).toBe(true);
    // The longest-idle candidate that clears every guard.
    expect(manager.terminals.has(`panel-${MAX_LIVE_TERMINALS - 4}`)).toBe(false);
  });

  it('spares every hidden sibling in the session last seen on screen', () => {
    // The real shape the guard exists for: inactive terminal tabs stay mounted
    // behind display:none, so they report hidden while the user is looking at
    // that pane. In batterySaver mode a window blur hides even the front tab.
    const manager = testAccess<SuspendIdleAccess>(new TerminalPanelManager());
    fill(manager, MAX_LIVE_TERMINALS, (i) => (
      i >= MAX_LIVE_TERMINALS - 3 ? { sessionId: 'on-screen' } : {}
    ));
    stubAgentStates(manager);
    // The user looks at the pane, then the window loses focus and every one of
    // its terminals reports hidden.
    manager.setVisibility(`panel-${MAX_LIVE_TERMINALS - 1}`, true);
    manager.setVisibility(`panel-${MAX_LIVE_TERMINALS - 1}`, false);

    manager.suspendIdleTerminals(NOW);

    for (let i = MAX_LIVE_TERMINALS - 3; i < MAX_LIVE_TERMINALS; i++) {
      expect(manager.terminals.has(`panel-${i}`)).toBe(true);
    }
    expect(manager.terminals.has(`panel-${MAX_LIVE_TERMINALS - 4}`)).toBe(false);
  });

  it('never suspends a panel whose agent status has not published yet', () => {
    // Every panel is registered with the monitor, so `undefined` means "unknown",
    // not "no agent here" — a freshly launched agent reads this way before its
    // first publish, and so does one parked in an agent-owned viewer.
    const manager = testAccess<SuspendIdleAccess>(new TerminalPanelManager());
    fill(manager, MAX_LIVE_TERMINALS);
    vi.spyOn(manager.agentStatusMonitor, 'getState').mockReturnValue(undefined);

    manager.suspendIdleTerminals(NOW);

    expect(manager.terminals.size).toBe(MAX_LIVE_TERMINALS);
  });

  it('never suspends a terminal quiet for less than the idle window', () => {
    const manager = testAccess<SuspendIdleAccess>(new TerminalPanelManager());
    // Every guard satisfied except the window: hidden and idle-stated, but all
    // active a second ago. Without the window check these are all evictable.
    fill(manager, MAX_LIVE_TERMINALS, () => ({ lastActivity: new Date(NOW - 1000) }));
    stubAgentStates(manager);

    manager.suspendIdleTerminals(NOW);

    expect(manager.terminals.size).toBe(MAX_LIVE_TERMINALS);
  });

  it('fails open when nothing is suspendable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = testAccess<SuspendIdleAccess>(new TerminalPanelManager());
    fill(manager, MAX_LIVE_TERMINALS, () => ({ isVisible: true }));
    stubAgentStates(manager);

    manager.suspendIdleTerminals(NOW);

    expect(manager.terminals.size).toBe(MAX_LIVE_TERMINALS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('none suspendable'));
  });

  it('marks a suspended CLI panel interrupted so its next launch resumes', async () => {
    const manager = testAccess<SuspendIdleAccess>(new TerminalPanelManager());
    fill(manager, MAX_LIVE_TERMINALS);
    stubAgentStates(manager);
    const oldest = `panel-${MAX_LIVE_TERMINALS - 1}`;
    const panelState = { customState: { agentType: 'codex' } };
    vi.mocked(panelManager.getPanel).mockImplementation((panelId: string) => (
      // SAFETY: markPanelInterrupted reads only `state.customState` off the panel.
      panelId === oldest ? ({ id: oldest, state: panelState } as ReturnType<typeof panelManager.getPanel>) : undefined
    ));

    manager.suspendIdleTerminals(NOW);

    // Codex and Cursor resume only when this is set; without it they restart empty.
    expect(panelState.customState).toMatchObject({ wasInterrupted: true, agentType: 'codex' });
    // And it has to reach the panel store, not just the in-memory panel.
    // `destroyTerminal` starts that save without awaiting it.
    await vi.waitFor(() => expect(panelManager.updatePanel).toHaveBeenCalled());
    expect(panelManager.updatePanel).toHaveBeenCalledWith(
      oldest,
      expect.objectContaining({
        state: expect.objectContaining({
          customState: expect.objectContaining({ wasInterrupted: true, agentType: 'codex' }),
        }),
      }),
    );
  });

  it('does not mark a plain shell interrupted', () => {
    const manager = testAccess<SuspendIdleAccess>(new TerminalPanelManager());
    fill(manager, MAX_LIVE_TERMINALS);
    stubAgentStates(manager);
    const oldest = `panel-${MAX_LIVE_TERMINALS - 1}`;
    const panelState = { customState: { initialCommand: 'npm run dev' } };
    vi.mocked(panelManager.getPanel).mockImplementation((panelId: string) => (
      // SAFETY: markPanelInterrupted reads only `state.customState` off the panel.
      panelId === oldest ? ({ id: oldest, state: panelState } as ReturnType<typeof panelManager.getPanel>) : undefined
    ));

    manager.suspendIdleTerminals(NOW);

    expect(manager.terminals.has(oldest)).toBe(false);
    expect(panelState.customState).not.toHaveProperty('wasInterrupted');
  });

  it('spares a session another viewer is still watching', () => {
    // Viewers are plural: the Remote PWA re-asserts visibility on a heartbeat.
    // A single global pin would be overwritten by whoever reported last.
    const manager = testAccess<SuspendIdleAccess>(new TerminalPanelManager());
    // Idleness grows with the index, so the terminals a broken pin would take
    // first are the highest ones. Both pinned sessions therefore own a hidden
    // terminal up there: desktop has the top two, and remote has the next.
    // Anything lower could survive a broken pin by luck rather than by guard.
    fill(manager, MAX_LIVE_TERMINALS, (i) => {
      if (i >= MAX_LIVE_TERMINALS - 2) return { sessionId: 'desktop' };
      if (i === MAX_LIVE_TERMINALS - 3 || i === 0) return { sessionId: 'remote' };
      return {};
    });
    stubAgentStates(manager);
    // Desktop is on its pane, then the window blurs and its terminals hide.
    manager.setVisibility(`panel-${MAX_LIVE_TERMINALS - 1}`, true, 'local:legacy');
    manager.setVisibility(`panel-${MAX_LIVE_TERMINALS - 1}`, false, 'local:legacy');
    // A remote viewer of a different session keeps heartbeating. Only panel-0
    // is visible; its session-mate higher up is hidden and can be saved by
    // nothing except the pin.
    manager.setVisibility('panel-0', true, 'daemon:remote-1');

    manager.suspendIdleTerminals(NOW);

    // The desktop pane must survive the remote viewer's heartbeat...
    expect(manager.terminals.has(`panel-${MAX_LIVE_TERMINALS - 1}`)).toBe(true);
    expect(manager.terminals.has(`panel-${MAX_LIVE_TERMINALS - 2}`)).toBe(true);
    // ...and so must the remote's hidden terminal, which only the pin protects...
    expect(manager.terminals.has(`panel-${MAX_LIVE_TERMINALS - 3}`)).toBe(true);
    // ...while an unpinned terminal is still actually reclaimed, so this cannot
    // pass by sparing everything.
    expect(manager.terminals.has(`panel-${MAX_LIVE_TERMINALS - 4}`)).toBe(false);
  });

  it('arms the deferred kill for a WSL terminal even when the exit write throws', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = testAccess<SuspendIdleAccess>(new TerminalPanelManager());
    fill(manager, MAX_LIVE_TERMINALS, () => ({ isWSL: true }));
    stubAgentStates(manager);
    const doomed = manager.terminals.get(`panel-${MAX_LIVE_TERMINALS - 1}`);
    // pty.write throws on a PTY that is already going away.
    doomed?.pty.write.mockImplementation(() => { throw new Error('pty gone'); });

    manager.suspendIdleTerminals(NOW);

    // WSL exits on the write first, so the kill is deferred...
    expect(doomed?.pty.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    // ...but it must still be armed, or the process is never reclaimed.
    expect(doomed?.pty.kill).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Graceful exit write failed'),
      expect.anything(),
    );
    vi.useRealTimers();
  });

  it('kills every PTY in destroyAllTerminals even when one fails to flush', () => {
    // The quit path. `this.terminals.clear()` runs straight after the loop, so
    // a skipped kill leaves nothing able to reclaim that shell.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = testAccess<SuspendIdleAccess>(new TerminalPanelManager());
    fill(manager, 3);
    const terminals = ['panel-0', 'panel-1', 'panel-2'].map(id => manager.terminals.get(id));
    // Populate the maps the assertions below check. Without this they pass even
    // with the production `clear()` calls deleted, because nothing ever filled
    // them.
    manager.setVisibility('panel-0', true, 'local:legacy');
    manager.saveSerializedSnapshot('panel-2', 'serialized');
    expect(manager.visibleViewersByPanel.size).toBe(1);
    expect(manager.serializedBuffers.size).toBe(1);
    expect(manager.sessionLastVisibleAt.size).toBe(1);

    vi.spyOn(manager, 'flushOutputBuffer').mockImplementation((terminal) => {
      if (terminal.panelId === 'panel-1') throw new Error('event sink exploded');
    });

    manager.destroyAllTerminals();

    // Every PTY, not just the one that threw: a shared `try` would cost the
    // throwing panel its kill, and an escaped throw would cost every later one.
    for (const terminal of terminals) {
      expect(terminal?.pty.kill).toHaveBeenCalled();
    }
    expect(manager.terminals.size).toBe(0);
    expect(manager.visibleViewersByPanel.size).toBe(0);
    expect(manager.serializedBuffers.size).toBe(0);
    expect(manager.sessionLastVisibleAt.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Final output flush failed'),
      expect.anything(),
    );
  });

  it('re-pins a session on every visible report, not only on the transition', () => {
    // `noteSessionVisible` sits above `applyVisibilityState`'s no-op early
    // return. Moving it below would compile and pass every other test, while
    // silently breaking the Remote PWA: its heartbeat re-asserts visibility
    // without a transition, so a watched session would pin once and then expire
    // under an active viewer.
    const manager = testAccess<SuspendIdleAccess>(new TerminalPanelManager());
    fill(manager, 1, () => ({ sessionId: 'watched' }));

    manager.setVisibility('panel-0', true, 'daemon:remote-1');
    expect(manager.sessionLastVisibleAt.has('watched')).toBe(true);

    // Age the pin as it would be after a quiet fifteen minutes.
    manager.sessionLastVisibleAt.set('watched', Date.now() - TERMINAL_IDLE_SUSPEND_MS - 1000);
    // The heartbeat: already visible, so the transition check short-circuits.
    manager.setVisibility('panel-0', true, 'daemon:remote-1');

    const seenAt = manager.sessionLastVisibleAt.get('watched') ?? 0;
    expect(Date.now() - seenAt).toBeLessThan(TERMINAL_IDLE_SUSPEND_MS);
  });

  it('still releases a terminal whose final output flush throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = testAccess<SuspendIdleAccess>(new TerminalPanelManager());
    fill(manager, MAX_LIVE_TERMINALS);
    stubAgentStates(manager);
    const oldest = `panel-${MAX_LIVE_TERMINALS - 1}`;
    const doomed = manager.terminals.get(oldest);
    // The production event-sink fanout rethrows its first subscriber error.
    vi.spyOn(manager, 'flushOutputBuffer').mockImplementation((terminal) => {
      if (terminal.panelId === oldest) throw new Error('event sink exploded');
    });

    // Must not escape: initializeTerminal calls this inside the try whose
    // finally releases the spawn slot.
    expect(() => manager.suspendIdleTerminals(NOW)).not.toThrow();

    // And the terminal must still be gone, or every later pass re-picks it.
    expect(manager.terminals.has(oldest)).toBe(false);
    expect(doomed?.pty.kill).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Final output flush failed'),
      expect.anything(),
    );
  });
});
