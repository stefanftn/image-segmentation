using System.Diagnostics;
using Microsoft.Extensions.Logging;

namespace ImageSeg.Application.Images.Processing;

/// <summary>
/// Outermost processing decorator (spec §4.4, §10). Opens the correlation-scoped logging scope
/// that every inner decorator inherits, so every log line for a task's processing joins on one
/// id even with no dashboard or distributed tracing infrastructure behind it - structured,
/// correlation-scoped logging is kept explicitly (spec §10) while metrics infrastructure is
/// dropped.
/// </summary>
public sealed class LoggingProcessorDecorator : ITaskProcessor
{
    private readonly ITaskProcessor _inner;
    private readonly ILogger<LoggingProcessorDecorator> _logger;

    public LoggingProcessorDecorator(ITaskProcessor inner, ILogger<LoggingProcessorDecorator> logger)
    {
        _inner = inner;
        _logger = logger;
    }

    public async Task ProcessAsync(TaskProcessingContext context, CancellationToken ct)
    {
        using var scope = _logger.BeginScope(new Dictionary<string, object>
        {
            ["CorrelationId"] = context.CorrelationId,
            ["RequestId"] = context.TaskId
        });

        var sw = Stopwatch.StartNew();
        _logger.LogInformation("Processing task, operation={Operation} mode={Mode}.",
            context.Operation, context.Mode ?? "-");

        try
        {
            await _inner.ProcessAsync(context, ct);
            sw.Stop();
            _logger.LogInformation("Task completed in {Elapsed}ms.", (int)sw.Elapsed.TotalMilliseconds);
        }
        catch (Exception ex)
        {
            sw.Stop();
            _logger.LogError(ex, "Task failed after {Elapsed}ms.", (int)sw.Elapsed.TotalMilliseconds);
            throw;
        }
    }
}
