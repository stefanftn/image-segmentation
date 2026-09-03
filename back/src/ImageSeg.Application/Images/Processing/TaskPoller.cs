using ImageSeg.Application.Images.Interfaces;
using ImageSeg.Domain.Images.Interfaces;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Prometheus;

namespace ImageSeg.Application.Images.Processing;

/// <summary>
/// Spec §4. Replaces the old outbox worker, Kafka, and the Kafka consumer together - this is
/// the single most important mechanical change from the prototype.
///
/// Claim semantics (spec §4.1-§4.2): <c>IImageTaskRepository.ClaimBatchAsync</c> uses
/// <c>SELECT ... FOR UPDATE SKIP LOCKED</c> so two poller instances never claim the same
/// <c>Pending</c> row. Once a claimed task's state moves to <c>Preprocessing</c>, it becomes
/// structurally invisible to the claim query - not because of the lease, but because the
/// <c>WHERE State = 'Pending'</c> predicate itself excludes it. A crash mid-Processing leaves
/// the task stuck with no re-claim possible; recovery is <see cref="StaleTaskSweeperWorker"/>'s
/// job, not a redelivery mechanism the way Kafka's at-least-once guarantee was.
///
/// This is exactly why the old <c>IdempotentTaskProcessor</c> guard is gone rather than carried
/// over (see the non-goals section of the spec and the README's "Open Decisions" note): the
/// scenario it protected against - a message redelivered mid-processing - cannot occur under
/// this claim design. The pipeline itself remains at-least-once *within a single claim*, since
/// RetryProcessorDecorator can retry a legitimate transient failure, but that retry re-enters
/// the SAME in-memory call, never a second independent claim of the same row.
/// </summary>
public sealed class TaskPoller : BackgroundService
{
    // Static (not per-instance): every "web" replica registers into the same process-wide
    // DefaultRegistry that prometheus-net.AspNetCore's MapMetrics() serves from Program.cs.
    // Per replica, each replica's own /metrics naturally reports only that replica's counts -
    // Prometheus does the summing across replicas at query time (sum(imageseg_taskpoller_claimed_total)),
    // same pattern as the ai-sidecar's SEGMENT_REQUESTS counter.
    private static readonly Counter ClaimedTotal = Metrics.CreateCounter(
        "imageseg_taskpoller_claimed_total", "Tasks claimed off the Pending queue by this replica.");

    private static readonly Counter ClaimCycleErrorsTotal = Metrics.CreateCounter(
        "imageseg_taskpoller_claim_cycle_errors_total", "Claim cycles that threw before completing.");

    private static readonly Gauge InFlightTasks = Metrics.CreateGauge(
        "imageseg_inflight_tasks", "Tasks currently occupying an InFlightLimiter permit on this replica (active sidecar calls).");

    private static readonly Gauge PendingTasks = Metrics.CreateGauge(
        "imageseg_pending_tasks", "Actual Pending-state backlog in Postgres right now (the real queue depth, not just this replica's batch size).");

    // CountPendingAsync is a plain COUNT(*) - cheap, but no reason to run it on every poll cycle
    // (which can be sub-second when the queue is busy). Refreshed every Nth cycle instead,
    // reusing whichever scope/repository that cycle already created for ClaimBatchAsync.
    private const int BacklogRefreshEveryNCycles = 5;
    private int _cyclesSinceBacklogRefresh;

    private readonly IServiceScopeFactory _scopeFactory;
    private readonly InFlightLimiter _limiter;
    private readonly PollerOptions _pollerOptions;
    private readonly ProcessorOptions _processorOptions;
    private readonly TimeProvider _clock;
    private readonly ILogger<TaskPoller> _logger;

    public TaskPoller(
        IServiceScopeFactory scopeFactory,
        InFlightLimiter limiter,
        IOptions<PollerOptions> pollerOptions,
        IOptions<ProcessorOptions> processorOptions,
        TimeProvider clock,
        ILogger<TaskPoller> logger)
    {
        _scopeFactory = scopeFactory;
        _limiter = limiter;
        _pollerOptions = pollerOptions.Value;
        _processorOptions = processorOptions.Value;
        _clock = clock;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("TaskPoller starting: batchSize={BatchSize} leaseSeconds={Lease} maxInFlight={MaxInFlight}.",
            _pollerOptions.BatchSize, _pollerOptions.LeaseDurationSeconds, _processorOptions.MaxInFlightPerInstance);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                // §4.3 backpressure: the direct-Postgres equivalent of pausing Kafka partition
                // consumption - skip a poll cycle instead of claiming work this instance has
                // no capacity to act on soon.
                InFlightTasks.Set(_limiter.Capacity - _limiter.Semaphore.CurrentCount);

                if (_limiter.Semaphore.CurrentCount == 0)
                {
                    await Task.Delay(_pollerOptions.BackpressurePollIntervalMs, stoppingToken);
                    continue;
                }

                IReadOnlyList<Domain.Images.Entities.ImageTask> claimed;
                using (var scope = _scopeFactory.CreateScope())
                {
                    var repository = scope.ServiceProvider.GetRequiredService<IImageTaskRepository>();
                    claimed = await repository.ClaimBatchAsync(
                        _pollerOptions.BatchSize,
                        TimeSpan.FromSeconds(_pollerOptions.LeaseDurationSeconds),
                        _clock.GetUtcNow().UtcDateTime,
                        stoppingToken);

                    if (++_cyclesSinceBacklogRefresh >= BacklogRefreshEveryNCycles)
                    {
                        _cyclesSinceBacklogRefresh = 0;
                        PendingTasks.Set(await repository.CountPendingAsync(stoppingToken));
                    }
                }

                if (claimed.Count == 0)
                {
                    await Task.Delay(_pollerOptions.EmptyPollIntervalMs, stoppingToken);
                    continue;
                }

                ClaimedTotal.Inc(claimed.Count);
                _logger.LogDebug("Claimed {Count} task(s).", claimed.Count);

                // Fire-and-forget per claimed task: each gets its own DI scope (fresh
                // DbContext) and its own bounded lifetime. Not awaited here - awaiting would
                // serialize the batch and defeat the point of claiming more than one row at a
                // time.
                foreach (var task in claimed)
                {
                    _ = DispatchAsync(task, stoppingToken);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                ClaimCycleErrorsTotal.Inc();
                _logger.LogError(ex, "TaskPoller claim cycle failed; will retry on the next cycle.");
                await Task.Delay(_pollerOptions.EmptyPollIntervalMs, stoppingToken);
            }
        }
    }

    private async Task DispatchAsync(Domain.Images.Entities.ImageTask task, CancellationToken appStoppingToken)
    {
        using var scope = _scopeFactory.CreateScope();
        var sp = scope.ServiceProvider;

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(appStoppingToken);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(_processorOptions.TaskProcessingTimeoutSeconds));

        var processor = sp.GetRequiredService<ITaskProcessor>();
        var taskService = sp.GetRequiredService<IImageTaskService>();

        var context = new TaskProcessingContext
        {
            TaskId = task.Id,
            CorrelationId = task.CorrelationId,
            Operation = task.Operation,
            Mode = task.Mode,
            OriginalFilePath = task.OriginalFilePath,
            StorageProvider = task.StorageProvider
        };

        try
        {
            await processor.ProcessAsync(context, timeoutCts.Token);
        }
        catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested && !appStoppingToken.IsCancellationRequested)
        {
            _logger.LogError("Task {TaskId} exceeded TaskProcessingTimeoutSeconds={Timeout}s; marking Failed.",
                task.Id, _processorOptions.TaskProcessingTimeoutSeconds);
            await SafeFailAsync(taskService, task.Id, "Timeout: task exceeded the maximum processing time.", appStoppingToken);
        }
        catch (OperationCanceledException) when (appStoppingToken.IsCancellationRequested)
        {
            // App shutdown mid-task: leave the row exactly as it is. StaleTaskSweeperWorker
            // (or a restarted instance's own sweep) reconciles it if it never resumes.
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Task {TaskId} failed.", task.Id);
            await SafeFailAsync(taskService, task.Id, Truncate(ex.Message, 2000), appStoppingToken);
        }
    }

    private async Task SafeFailAsync(IImageTaskService taskService, Guid taskId, string message, CancellationToken ct)
    {
        try
        {
            await taskService.FailAsync(taskId, message, ct);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to write Failed state for task {TaskId} after a processing error.", taskId);
        }
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}
