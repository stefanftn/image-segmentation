using ImageSeg.Application.Images.Interfaces;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace ImageSeg.Application.Images.Processing;

/// <summary>
/// Spec §4.5 - the backstop for tasks that will otherwise never reach a terminal state: an
/// instance killed between a state write and its next step, a sidecar hang that escapes its
/// own Polly timeout. Needs only Postgres, so it is independent of TaskPoller's claim cycle.
///
/// Running it in every Web replica is safe: the underlying UPDATE is guarded on the non-terminal
/// state (IImageTaskRepository.SweepStaleAsync), so whichever replica gets there first wins and
/// the others affect zero rows.
/// </summary>
public sealed class StaleTaskSweeperWorker : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly SweeperOptions _options;
    private readonly ILogger<StaleTaskSweeperWorker> _logger;

    public StaleTaskSweeperWorker(IServiceScopeFactory scopeFactory, IOptions<SweeperOptions> options, ILogger<StaleTaskSweeperWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _options = options.Value;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var interval = TimeSpan.FromSeconds(_options.IntervalSeconds);
        await Task.Delay(TimeSpan.FromSeconds(Random.Shared.Next(5, 30)), stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await SweepAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Stale task sweep failed.");
            }

            await Task.Delay(interval, stoppingToken);
        }
    }

    private async Task SweepAsync(CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var taskService = scope.ServiceProvider.GetRequiredService<IImageTaskService>();

        var affected = await taskService.SweepStaleAsync(
            TimeSpan.FromMinutes(_options.MaxTaskDurationMinutes), _options.BatchSize, ct);

        if (affected > 0)
            _logger.LogWarning("Force-failed {Count} tasks stuck beyond {Minutes} minutes.", affected, _options.MaxTaskDurationMinutes);
    }
}
