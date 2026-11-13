/**
 * Scripted DAP adapter used by the debug tests — a real child process, no
 * network. The script is handed to `node -e` and speaks `Content-Length`
 * framed DAP over stdio, mirroring debugpy's stdio adapter:
 *
 *   - `launch` is answered only after `configurationDone` (debugpy semantics),
 *   - `initialize` answers capabilities and emits `initialized`,
 *   - `configurationDone` produces the first stop/termination for the
 *     selected scenario,
 *   - `continue` either stops again (`entry`) or never does (`running`).
 *
 * Scenarios:
 *   entry        — stop on entry, then stop again on continue
 *   running      — stop on entry, then keep running (continue timeout path)
 *   terminate    — the debuggee exits after configurationDone
 *   launch-error — the launch request fails once configurationDone answers
 */

export type FakeDapScenario = 'entry' | 'running' | 'terminate' | 'launch-error';

const SCRIPT_BODY = `
var scenario = '__SCENARIO__';
var buffer = Buffer.alloc(0);
var seq = 0;
var launchRequest = null;

function send(message) {
  seq += 1;
  message.seq = seq;
  var payload = JSON.stringify(message);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(payload, 'utf8') + '\\r\\n\\r\\n' + payload);
}

function respond(request, body) {
  send({ type: 'response', request_seq: request.seq, success: true, command: request.command, body: body || {} });
}

function fail(request, message) {
  send({ type: 'response', request_seq: request.seq, success: false, command: request.command, message: message });
}

function emit(name, body) {
  send({ type: 'event', event: name, body: body || {} });
}

function stopped(reason) {
  emit('stopped', { reason: reason, threadId: 1, allThreadsStopped: true, description: 'Paused in the fake debuggee' });
}

function handle(request) {
  var args = request.arguments || {};
  switch (request.command) {
    case 'initialize':
      respond(request, {
        supportsConfigurationDoneRequest: true,
        supportsEvaluateForHovers: true,
        exceptionBreakpointFilters: []
      });
      emit('initialized', {});
      return;
    case 'launch':
      if (!args.program) {
        fail(request, 'launch requires a program');
        return;
      }
      if (args.console !== 'internalConsole') {
        // Mirrors debugpy: without internalConsole it answers the launch with a
        // runInTerminal request, which this client does not support.
        fail(request, 'console must be internalConsole');
        return;
      }
      launchRequest = request;
      return;
    case 'attach':
      if (args.port !== 5678) {
        fail(request, 'no debuggee listening on port ' + args.port);
        return;
      }
      respond(request, {});
      return;
    case 'setBreakpoints':
      var requested = args.breakpoints || [];
      respond(request, {
        breakpoints: requested.map(function (breakpoint) {
          return breakpoint.line <= 10
            ? { verified: true, line: breakpoint.line }
            : { verified: false, line: breakpoint.line, message: 'no executable code at line ' + breakpoint.line };
        })
      });
      return;
    case 'configurationDone':
      respond(request, {});
      if (launchRequest !== null) {
        if (scenario === 'launch-error') {
          fail(launchRequest, 'launch failed: no such program');
        } else {
          respond(launchRequest, {});
        }
        launchRequest = null;
      }
      if (scenario === 'launch-error') return;
      if (scenario === 'terminate') {
        setTimeout(function () {
          emit('exited', { exitCode: 0 });
          emit('terminated', {});
        }, 10);
        return;
      }
      setTimeout(function () {
        stopped('entry');
      }, 10);
      return;
    case 'stackTrace':
      respond(request, {
        stackFrames: [
          { id: 1, name: 'main', source: { path: '/tmp/fake_program.py', name: 'fake_program.py' }, line: 3, column: 1 },
          { id: 2, name: 'helper', source: { path: '/tmp/fake_program.py', name: 'fake_program.py' }, line: 9, column: 5 }
        ],
        totalFrames: 2
      });
      return;
    case 'scopes':
      if (args.frameId === 2) {
        respond(request, { scopes: [{ name: 'Locals', variablesReference: 2000, expensive: false }] });
        return;
      }
      respond(request, {
        scopes: [
          { name: 'Locals', variablesReference: 1000, expensive: false },
          { name: 'Globals', variablesReference: 1001, expensive: true }
        ]
      });
      return;
    case 'variables':
      if (args.variablesReference === 1000) {
        respond(request, {
          variables: [
            { name: 'x', value: '42', type: 'int', variablesReference: 0 },
            { name: 'name', value: "'ada'", type: 'str', variablesReference: 0 },
            { name: 'items', value: '[1]', type: 'list', variablesReference: 1002 }
          ]
        });
        return;
      }
      if (args.variablesReference === 1002) {
        respond(request, { variables: [{ name: '0', value: '1', type: 'int', variablesReference: 0 }] });
        return;
      }
      if (args.variablesReference === 1001) {
        respond(request, { variables: [{ name: '__name__', value: "'__main__'", type: 'str', variablesReference: 0 }] });
        return;
      }
      respond(request, { variables: [] });
      return;
    case 'evaluate':
      if (args.expression === 'boom') {
        fail(request, "NameError: name 'boom' is not defined");
        return;
      }
      respond(request, { result: '42', type: 'int', variablesReference: 0 });
      return;
    case 'continue':
      respond(request, { allThreadsContinued: true });
      if (scenario === 'running') return;
      setTimeout(function () {
        stopped('breakpoint');
      }, 10);
      return;
    case 'disconnect':
      respond(request, {});
      setTimeout(function () {
        process.exit(0);
      }, 5);
      return;
    default:
      respond(request, {});
  }
}

function drain() {
  while (true) {
    var headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd === -1) return;
    var header = buffer.subarray(0, headerEnd).toString('utf8');
    var match = /Content-Length:\\s*(\\d+)/i.exec(header);
    var bodyStart = headerEnd + 4;
    if (match === null) {
      buffer = buffer.subarray(bodyStart);
      continue;
    }
    var length = Number(match[1]);
    if (buffer.length < bodyStart + length) return;
    var body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
    buffer = buffer.subarray(bodyStart + length);
    handle(JSON.parse(body));
  }
}

process.stdin.on('data', function (chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});
process.stdin.resume();
`;

/** `node -e <script>` command line for one scenario. */
export function fakeDapCommand(scenario: FakeDapScenario): string[] {
  return ['node', '-e', SCRIPT_BODY.replace('__SCENARIO__', scenario)];
}
