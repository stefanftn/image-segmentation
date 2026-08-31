using ImageSeg.Domain.Images.Exceptions;
using ImageSeg.Domain.Shared.Exceptions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Polly;

namespace ImageSeg.Application.Images.Processing;

/// <summary>
/// Spec §4.4 - retries transient failures WITHIN the .NET pipeline: brief DB unavailability
/// during a state write, a flaky storage read, and so on.
///
/// Deliberately does NOT cover the outbound sidecar call - that has its own retry, circuit
/// breaker and timeout attached to its HttpClient (see Infrastructure's RoutingSegmentationClient
/// wiring in Program.cs). Retrying an already-retried sidecar call here would multiply the
/// attempt count and defeat the breaker by re-entering it from outside. This also matters for
/// state integrity, not just efficiency: re-entering ImagePreprocessingDecorator on a retry
/// would re-issue an illegal Processing -&gt; Preprocessing transition.
/// </summary>
public sealed class RetryProcessorDecorator : ITaskProcessor
{
    private readonly ITaskProcessor _inner;
    private readonly ResiliencePipeline _pipeline;

    public RetryProcessorDecorator(ITaskProcessor inner, IOptions<ProcessorOptions> options, ILogger<RetryProcessorDecorator> logger)
    {
        _inner = inner;

        var o = options.Value;
        _pipeline = new ResiliencePipelineBuilder()
            .AddRetry(new Polly.Retry.RetryStrategyOptions
            {
                MaxRetryAttempts = o.PipelineRetryCount,
                Delay = TimeSpan.FromMilliseconds(o.PipelineRetryBaseDelayMs),
                BackoffType = DelayBackoffType.Exponential,
                UseJitter = true,
                ShouldHandle = new PredicateBuilder()
                    .Handle<Exception>(ex => ex switch
                    {
                        // Deterministic - a retry fails identically. Signals an illegal or
                        // out-of-order state write.
                        InvalidStateTransitionException => false,

                        // Our own cancellation (shutdown, message-level timeout) - never worth retrying.
                        OperationCanceledException => false,

                        // Everything the sidecar's OWN resilience pipeline already retried and
                        // gave up on (see class remarks) - includes ColabBackendException via
                        // the SidecarException base type.
                        SidecarException => false,

                        _ => true
                    }),
                OnRetry = args =>
                {
                    logger.LogWarning(args.Outcome.Exception,
                        "Pipeline retry {Attempt} after {Delay}ms.", args.AttemptNumber + 1, args.RetryDelay.TotalMilliseconds);
                    return ValueTask.CompletedTask;
                }
            })
            .Build();
    }

    public Task ProcessAsync(TaskProcessingContext context, CancellationToken ct)
    {
        var state = (Processor: _inner, Context: context);
        return _pipeline.ExecuteAsync(
            static async (s, token) => await s.Processor.ProcessAsync(s.Context, token),
            state, ct).AsTask();
    }
}
