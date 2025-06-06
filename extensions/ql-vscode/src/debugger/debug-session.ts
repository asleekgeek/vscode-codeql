import {
  ContinuedEvent,
  Event,
  ExitedEvent,
  InitializedEvent,
  LoggingDebugSession,
  OutputEvent,
  ProgressEndEvent,
  StoppedEvent,
  TerminatedEvent,
} from "@vscode/debugadapter";
import type { DebugProtocol as Protocol } from "@vscode/debugprotocol";
import type { Disposable } from "vscode";
import { CancellationTokenSource } from "vscode-jsonrpc";
import type { BaseLogger, LogOptions } from "../common/logging";
import { queryServerLogger } from "../common/logging/vscode";
import { QueryResultType } from "../query-server/messages";
import type {
  CoreQueryResult,
  CoreQueryRun,
  QueryRunner,
} from "../query-server";
// eslint-disable-next-line import/no-namespace -- There are two different debug protocols, so we should make a distinction.
import type * as CodeQLProtocol from "./debug-protocol";
import type { QuickEvalContext } from "../run-queries-shared";
import { getErrorMessage } from "../common/helpers-pure";
import { DisposableObject } from "../common/disposable-object";
import { basename } from "path";

// More complete implementations of `Event` for certain events, because the classes from
// `@vscode/debugadapter` make it more difficult to provide some of the message values.

class ProgressStartEvent extends Event implements Protocol.ProgressStartEvent {
  public readonly event = "progressStart";
  public readonly body: {
    progressId: string;
    title: string;
    requestId?: number;
    cancellable?: boolean;
    message?: string;
    percentage?: number;
  };

  constructor(
    progressId: string,
    title: string,
    message?: string,
    percentage?: number,
  ) {
    super("progressStart");
    this.body = {
      progressId,
      title,
      message,
      percentage,
    };
  }
}

class ProgressUpdateEvent
  extends Event
  implements Protocol.ProgressUpdateEvent
{
  public readonly event = "progressUpdate";
  public readonly body: {
    progressId: string;
    message?: string;
    percentage?: number;
  };

  constructor(progressId: string, message?: string, percentage?: number) {
    super("progressUpdate");
    this.body = {
      progressId,
      message,
      percentage,
    };
  }
}

class EvaluationStartedEvent
  extends Event
  implements CodeQLProtocol.EvaluationStartedEvent
{
  public readonly type = "event";
  public readonly event = "codeql-evaluation-started";
  public readonly body: CodeQLProtocol.EvaluationStartedEvent["body"];

  constructor(
    id: string,
    outputDir: string,
    quickEvalContext: QuickEvalContext | undefined,
  ) {
    super("codeql-evaluation-started");
    this.body = {
      id,
      outputDir,
      quickEvalContext,
    };
  }
}

class EvaluationCompletedEvent
  extends Event
  implements CodeQLProtocol.EvaluationCompletedEvent
{
  public readonly type = "event";
  public readonly event = "codeql-evaluation-completed";
  public readonly body: CodeQLProtocol.EvaluationCompletedEvent["body"];

  constructor(result: CoreQueryResult) {
    super("codeql-evaluation-completed");
    this.body = result;
  }
}

/**
 * Possible states of the debug session. Used primarily to guard against unexpected requests.
 */
type State =
  | "uninitialized"
  | "initialized"
  | "running"
  | "stopped"
  | "terminated";

// IDs for error messages generated by the debug adapter itself.

/** Received a DAP message while in an unexpected state. */
const ERROR_UNEXPECTED_STATE = 1;

/** ID of the "thread" that represents the query evaluation. */
const QUERY_THREAD_ID = 1;

/** The user-visible name of the query evaluation thread. */
const QUERY_THREAD_NAME = "Evaluation thread";

/**
 * An active query evaluation within a debug session.
 *
 * This class encapsulates the state and resources associated with the running query, to avoid
 * having multiple properties within `QLDebugSession` that are only defined during query evaluation.
 */
class RunningQuery extends DisposableObject {
  private readonly tokenSource = this.push(new CancellationTokenSource());
  public readonly queryRun: CoreQueryRun;
  private readonly queryPath: string;

  public constructor(
    queryRunner: QueryRunner,
    config: CodeQLProtocol.LaunchConfig,
    private readonly quickEvalContext: QuickEvalContext | undefined,
    queryStorageDir: string,
    private readonly logger: BaseLogger,
    private readonly sendEvent: (event: Event) => void,
  ) {
    super();

    this.queryPath = config.query;
    // Create the query run, which will give us some information about the query even before the
    // evaluation has completed.
    this.queryRun = queryRunner.createQueryRun(
      config.database,
      [
        {
          queryPath: this.queryPath,
          outputBaseName: "results",
          quickEvalPosition: quickEvalContext?.quickEvalPosition,
          quickEvalCountOnly: quickEvalContext?.quickEvalCount,
        },
      ],
      true,
      config.additionalPacks,
      config.extensionPacks,
      config.additionalRunQueryArgs,
      queryStorageDir,
      basename(config.query),
      undefined,
    );
  }

  public get id(): string {
    return this.queryRun.id;
  }

  /**
   * Evaluates the query, firing progress events along the way. The evaluation can be cancelled by
   * calling `cancel()`.
   *
   * This function does not throw exceptions to report query evaluation failure. It just returns an
   * evaluation result with a failure message instead.
   */
  public async evaluate(): Promise<
    CodeQLProtocol.EvaluationCompletedEvent["body"]
  > {
    // Send the `EvaluationStarted` event first, to let the client known where the outputs are
    // going to show up.
    this.sendEvent(
      new EvaluationStartedEvent(
        this.queryRun.id,
        this.queryRun.outputDir.querySaveDir,
        this.quickEvalContext,
      ),
    );

    try {
      // Report progress via the debugger protocol.
      const progressStart = new ProgressStartEvent(
        this.queryRun.id,
        "Running query",
        undefined,
        0,
      );
      progressStart.body.cancellable = true;
      this.sendEvent(progressStart);
      try {
        const completedQuery = await this.queryRun.evaluate(
          (p) => {
            const progressUpdate = new ProgressUpdateEvent(
              this.queryRun.id,
              p.message,
              (p.step * 100) / p.maxStep,
            );
            this.sendEvent(progressUpdate);
          },
          this.tokenSource.token,
          this.logger,
        );
        return (
          completedQuery.results.get(this.queryPath) ?? {
            resultType: QueryResultType.OTHER_ERROR,
            message: "Missing query results",
            evaluationTime: 0,
            outputBaseName: "unknown",
          }
        );
      } finally {
        this.sendEvent(new ProgressEndEvent(this.queryRun.id));
      }
    } catch (e) {
      const message = getErrorMessage(e);
      return {
        resultType: QueryResultType.OTHER_ERROR,
        message,
        evaluationTime: 0,
        outputBaseName: "unknown",
      };
    }
  }

  /**
   * Attempts to cancel the running evaluation.
   */
  public cancel(): void {
    this.tokenSource.cancel();
  }
}

/**
 * An in-process implementation of the debug adapter for CodeQL queries.
 *
 * For now, this is pretty much just a wrapper around the query server.
 */
export class QLDebugSession extends LoggingDebugSession implements Disposable {
  /** A `BaseLogger` that sends output to the debug console. */
  private readonly logger: BaseLogger = {
    log: async (message: string, _options: LogOptions): Promise<void> => {
      // Only send the output event if we're still connected to the query evaluation.
      if (this.runningQuery !== undefined) {
        this.sendEvent(new OutputEvent(message, "console"));
      }
    },
  };
  private state: State = "uninitialized";
  private terminateOnComplete = false;
  private args: CodeQLProtocol.LaunchRequest["arguments"] | undefined =
    undefined;
  private runningQuery: RunningQuery | undefined = undefined;
  private lastResultType: QueryResultType = QueryResultType.CANCELLATION;

  constructor(
    private readonly queryStorageDir: string,
    private readonly queryRunner: QueryRunner,
  ) {
    super();
  }

  public dispose(): void {
    if (this.runningQuery !== undefined) {
      this.runningQuery.cancel();
    }
  }

  protected dispatchRequest(request: Protocol.Request): void {
    // We just defer to the base class implementation, but having this override makes it easy to set
    // a breakpoint that will be hit for any message received by the debug adapter.
    void queryServerLogger.log(`DAP request: ${request.command}`);
    super.dispatchRequest(request);
  }

  private unexpectedState(response: Protocol.Response): void {
    this.sendErrorResponse(
      response,
      ERROR_UNEXPECTED_STATE,
      "CodeQL debug adapter received request '{_request}' while in unexpected state '{_actualState}'.",
      {
        _request: response.command,
        _actualState: this.state,
      },
    );
  }

  protected initializeRequest(
    response: Protocol.InitializeResponse,
    _args: Protocol.InitializeRequestArguments,
  ): void {
    switch (this.state) {
      case "uninitialized":
        response.body = response.body ?? {};
        response.body.supportsStepBack = false;
        response.body.supportsStepInTargetsRequest = false;
        response.body.supportsRestartFrame = false;
        response.body.supportsGotoTargetsRequest = false;
        response.body.supportsCancelRequest = true;
        response.body.supportsTerminateRequest = true;
        response.body.supportsModulesRequest = false;
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsRestartRequest = false;
        this.state = "initialized";
        this.sendResponse(response);

        this.sendEvent(new InitializedEvent());
        break;

      default:
        this.unexpectedState(response);
        break;
    }
  }

  protected disconnectRequest(
    response: Protocol.DisconnectResponse,
    _args: Protocol.DisconnectArguments,
    _request?: Protocol.Request,
  ): void {
    // The client is forcing a disconnect. We'll signal cancellation, but since this request means
    // that the debug session itself is about to go away, we'll stop processing events from the
    // evaluation to avoid sending them to the client that is no longer interested in them.
    this.terminateOrDisconnect(response, true);
  }

  protected terminateRequest(
    response: Protocol.TerminateResponse,
    _args: Protocol.TerminateArguments,
    _request?: Protocol.Request,
  ): void {
    // The client is requesting a graceful termination. This will signal the cancellation token of
    // any in-progress evaluation, but that evaluation will continue to report events (like
    // progress) until the cancellation takes effect.
    this.terminateOrDisconnect(response, false);
  }

  private terminateOrDisconnect(
    response: Protocol.Response,
    force: boolean,
  ): void {
    const runningQuery = this.runningQuery;
    if (force) {
      // Disconnect from the running query so that we stop processing its progress events.
      this.runningQuery = undefined;
    }
    if (runningQuery !== undefined) {
      this.terminateOnComplete = true;
      runningQuery.cancel();
    } else if (this.state === "stopped") {
      this.terminateAndExit();
    }

    this.sendResponse(response);
  }

  protected launchRequest(
    response: Protocol.LaunchResponse,
    args: CodeQLProtocol.LaunchRequest["arguments"],
    _request?: Protocol.Request,
  ): void {
    switch (this.state) {
      case "initialized":
        this.args = args;

        // If `noDebug` is set, then terminate after evaluation instead of stopping.
        this.terminateOnComplete = this.args.noDebug === true;

        response.body = response.body ?? {};

        // Send the response immediately. We'll send a "stopped" message when the evaluation is complete.
        this.sendResponse(response);

        void this.evaluate(this.args.quickEvalContext);
        break;

      default:
        this.unexpectedState(response);
        break;
    }
  }

  protected nextRequest(
    response: Protocol.NextResponse,
    _args: Protocol.NextArguments,
    _request?: Protocol.Request,
  ): void {
    this.stepRequest(response);
  }

  protected stepInRequest(
    response: Protocol.StepInResponse,
    _args: Protocol.StepInArguments,
    _request?: Protocol.Request,
  ): void {
    this.stepRequest(response);
  }

  protected stepOutRequest(
    response: Protocol.Response,
    _args: Protocol.StepOutArguments,
    _request?: Protocol.Request,
  ): void {
    this.stepRequest(response);
  }

  protected stepBackRequest(
    response: Protocol.StepBackResponse,
    _args: Protocol.StepBackArguments,
    _request?: Protocol.Request,
  ): void {
    this.stepRequest(response);
  }

  private stepRequest(response: Protocol.Response): void {
    switch (this.state) {
      case "stopped":
        this.sendResponse(response);
        // We don't do anything with stepping yet, so just announce that we've stopped without
        // actually doing anything.
        // We don't even send the `EvaluationCompletedEvent`.
        this.reportStopped();
        break;

      default:
        this.unexpectedState(response);
        break;
    }
  }

  protected continueRequest(
    response: Protocol.ContinueResponse,
    _args: Protocol.ContinueArguments,
    _request?: Protocol.Request,
  ): void {
    switch (this.state) {
      case "stopped":
        response.body = response.body ?? {};
        response.body.allThreadsContinued = true;

        // Send the response immediately. We'll send a "stopped" message when the evaluation is complete.
        this.sendResponse(response);

        void this.evaluate(undefined);
        break;

      default:
        this.unexpectedState(response);
        break;
    }
  }

  protected cancelRequest(
    response: Protocol.CancelResponse,
    args: Protocol.CancelArguments,
    _request?: Protocol.Request,
  ): void {
    if (
      args.progressId !== undefined &&
      this.runningQuery?.id === args.progressId
    ) {
      this.runningQuery.cancel();
    }

    this.sendResponse(response);
  }

  protected threadsRequest(
    response: Protocol.ThreadsResponse,
    _request?: Protocol.Request,
  ): void {
    response.body = response.body ?? {};
    response.body.threads = [
      {
        id: QUERY_THREAD_ID,
        name: QUERY_THREAD_NAME,
      },
    ];

    this.sendResponse(response);
  }

  protected stackTraceRequest(
    response: Protocol.StackTraceResponse,
    _args: Protocol.StackTraceArguments,
    _request?: Protocol.Request,
  ): void {
    response.body = response.body ?? {};
    response.body.stackFrames = []; // No frames for now.

    super.stackTraceRequest(response, _args, _request);
  }

  protected customRequest(
    command: string,
    response: CodeQLProtocol.Response,
    args: unknown,
    request?: Protocol.Request,
  ): void {
    switch (command) {
      case "codeql-quickeval": {
        this.quickEvalRequest(
          response,
          args as CodeQLProtocol.QuickEvalRequest["arguments"],
        );
        break;
      }

      default:
        super.customRequest(command, response, args, request);
        break;
    }
  }

  protected quickEvalRequest(
    response: CodeQLProtocol.QuickEvalResponse,
    args: CodeQLProtocol.QuickEvalRequest["arguments"],
  ): void {
    switch (this.state) {
      case "stopped":
        // Send the response immediately. We'll send a "stopped" message when the evaluation is complete.
        this.sendResponse(response);

        // For built-in requests that are expected to cause execution (`launch`, `continue`, `step`, etc.),
        // the adapter does not send a `continued` event because the client already knows that's what
        // is supposed to happen. For a custom request, though, we have to notify the client.
        this.sendEvent(new ContinuedEvent(QUERY_THREAD_ID, true));

        void this.evaluate(args.quickEvalContext);
        break;

      default:
        this.unexpectedState(response);
        break;
    }
  }

  /**
   * Runs the query or quickeval, and notifies the debugger client when the evaluation completes.
   *
   * This function is invoked from the `launch` and `continue` handlers, without awaiting its
   * result.
   */
  private async evaluate(
    quickEvalContext: QuickEvalContext | undefined,
  ): Promise<void> {
    const args = this.args!;

    const runningQuery = new RunningQuery(
      this.queryRunner,
      args,
      quickEvalContext,
      this.queryStorageDir,
      this.logger,
      (event) => {
        // If `this.runningQuery` is undefined, it means that we've already disconnected from this
        // evaluation, and do not want any further events.
        if (this.runningQuery !== undefined) {
          this.sendEvent(event);
        }
      },
    );
    this.runningQuery = runningQuery;
    this.state = "running";

    try {
      const result = await runningQuery.evaluate();
      this.completeEvaluation(result);
    } finally {
      this.runningQuery = undefined;
      runningQuery.dispose();
    }
  }

  /**
   * Mark the evaluation as completed, and notify the client of the result.
   */
  private completeEvaluation(
    result: CodeQLProtocol.EvaluationCompletedEvent["body"],
  ): void {
    this.lastResultType = result.resultType;

    // Report the evaluation result
    this.sendEvent(new EvaluationCompletedEvent(result));
    if (result.resultType !== QueryResultType.SUCCESS) {
      // Report the result message as "important" output
      const message = result.message ?? "Unknown error";
      const outputEvent = new OutputEvent(message, "console");
      this.sendEvent(outputEvent);
    }

    this.reportStopped();
  }

  private reportStopped(): void {
    if (this.terminateOnComplete) {
      this.terminateAndExit();
    } else {
      // Report the session as "stopped", but keep the session open.
      this.sendEvent(new StoppedEvent("entry", QUERY_THREAD_ID));

      this.state = "stopped";
    }
  }

  private terminateAndExit(): void {
    // Report the debugging session as terminated.
    this.sendEvent(new TerminatedEvent());

    // Report the debuggee as exited.
    this.sendEvent(new ExitedEvent(this.lastResultType));

    this.state = "terminated";
  }
}
