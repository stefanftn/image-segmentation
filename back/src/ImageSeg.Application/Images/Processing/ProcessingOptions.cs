namespace ImageSeg.Application.Images.Processing;

/// <summary>Poller:*  (spec §4). Governs TaskPoller's claim loop.</summary>
public sealed class PollerOptions
{
    public const string SectionName = "Poller";

    /// <summary>Rows claimed per SELECT ... FOR UPDATE SKIP LOCKED cycle.</summary>
    public int BatchSize { get; set; } = 10;

    /// <summary>
    /// How long a claimed row stays invisible to other claims before it is eligible again.
    /// Must comfortably exceed the worst-case time a task can spend between claim and its
    /// first state write (Pending -&gt; Preprocessing) - if it's too short, a second poller
    /// instance could reclaim a task that is still legitimately being picked up by the first.
    /// </summary>
    public int LeaseDurationSeconds { get; set; } = 60;

    /// <summary>How long to sleep after an empty claim (nothing Pending) before polling again.</summary>
    public int EmptyPollIntervalMs { get; set; } = 500;

    /// <summary>
    /// How long to sleep when the in-flight semaphore has no capacity (spec §4.3) - the
    /// direct-Postgres equivalent of the old system pausing Kafka partition consumption.
    /// </summary>
    public int BackpressurePollIntervalMs { get; set; } = 250;
}

/// <summary>Processor:*  (spec §4.4). Governs the decorator pipeline's own behaviour.</summary>
public sealed class ProcessorOptions
{
    public const string SectionName = "Processor";

    /// <summary>Bounded in-flight tasks per instance. Backpressure, not a queue.</summary>
    public int MaxInFlightPerInstance { get; set; } = 10;

    /// <summary>
    /// Ceiling on one task's total processing time, independent of the sidecar's own timeout.
    /// Must comfortably exceed the worst-case sidecar call - for a Regions task that means the
    /// Colab/local regions timeout plus its retry, plus preprocessing - otherwise this watchdog
    /// kills a legitimately-in-progress SAM call before the HTTP-level timeout/retry even gets
    /// a chance to finish. Sized well above that worst case rather than tuned tight to it, since
    /// a slow-but-working call should be allowed to finish; StaleTaskSweeperWorker is the
    /// backstop for anything that genuinely got stuck (spec §4.5), on a much longer horizon.
    /// </summary>
    public int TaskProcessingTimeoutSeconds { get; set; } = 900;

    /// <summary>Retries inside the .NET pipeline (RetryProcessorDecorator).</summary>
    public int PipelineRetryCount { get; set; } = 3;
    public int PipelineRetryBaseDelayMs { get; set; } = 250;

    /// <summary>Longest edge the image is downscaled to before it is sent to /segment.</summary>
    public int PreprocessMaxDimension { get; set; } = 1536;

    /// <summary>
    /// Longest edge for /regions specifically - deliberately separate from
    /// PreprocessMaxDimension, and deliberately lower. SAM's image encoder resizes to a fixed
    /// working resolution regardless of what is sent to it, so anything above that buys no
    /// encoder speedup - it only adds cost to per-point mask decoding and post-processing,
    /// both of which scale directly with pixel count.
    /// </summary>
    public int RegionsPreprocessMaxDimension { get; set; } = 1024;
}

/// <summary>Sweeper:*  (spec §4.5). Governs StaleTaskSweeperWorker.</summary>
public sealed class SweeperOptions
{
    public const string SectionName = "Sweeper";

    public int MaxTaskDurationMinutes { get; set; } = 15;
    public int IntervalSeconds { get; set; } = 60;
    public int BatchSize { get; set; } = 200;
}
