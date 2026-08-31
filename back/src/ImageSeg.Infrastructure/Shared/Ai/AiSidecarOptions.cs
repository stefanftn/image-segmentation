namespace ImageSeg.Infrastructure.Shared.Ai;

/// <summary>AiSidecar:*  (spec §7). Unchanged concept from the prototype - carried over exactly.</summary>
public sealed class AiSidecarOptions
{
    public const string SectionName = "AiSidecar";

    public string BaseUrl { get; set; } = "http://ai-sidecar:8000";

    /// <summary>Per-call timeout for POST /segment. Fast - typically seconds.</summary>
    public int RequestTimeoutSeconds { get; set; } = 60;

    public int RetryCount { get; set; } = 3;
    public int RetryBaseDelayMs { get; set; } = 200;

    /// <summary>
    /// Per-call timeout for POST /regions. The sidecar's own README documents SAM region
    /// computation as taking "a few seconds to a couple of minutes" on CPU - a fundamentally
    /// different latency profile from /segment, so it gets its own, much larger budget.
    /// </summary>
    public int RegionsRequestTimeoutSeconds { get; set; } = 240;

    /// <summary>
    /// Only one retry by default: retrying an already multi-minute call at full cost on every
    /// transient blip would make a slow-but-working call even slower.
    /// </summary>
    public int RegionsRetryCount { get; set; } = 1;
    public int RegionsRetryBaseDelayMs { get; set; } = 2000;

    public int CircuitBreakerFailureThreshold { get; set; } = 5;
    public int CircuitBreakerSamplingDurationSeconds { get; set; } = 30;
    public int CircuitBreakerBreakDurationSeconds { get; set; } = 20;

    /// <summary>
    /// Which backend serves POST /regions - "Local" (the CPU SAM model in ai-sidecar, default)
    /// or "Colab" (GPU-backed notebook over an ngrok tunnel). Segment never routes here - it
    /// always stays on the local sidecar.
    /// </summary>
    public string RegionsBackend { get; set; } = RegionsBackends.Local;

    public ColabOptions Colab { get; set; } = new();
}

public static class RegionsBackends
{
    public const string Local = "Local";
    public const string Colab = "Colab";
}

/// <summary>
/// AiSidecar:Colab:*  - a GPU-backed alternative for POST /regions only, reached over an ngrok
/// tunnel from a Google Colab notebook (free tier: T4 GPU, no persistent session).
///
/// Deliberately clean-fail, no automatic fallback to the local CPU SAM model (spec §7): an
/// ngrok free URL changes on every notebook restart and the session itself expires after
/// inactivity, so "Colab is unreachable" is an expected, common failure mode. No automatic URL
/// rediscovery - updating <see cref="BaseUrl"/> and restarting the Web process is the entire
/// update mechanism, on purpose.
/// </summary>
public sealed class ColabOptions
{
    /// <summary>The ngrok URL currently printed by the Colab notebook's tunnel cell. Changes every restart.</summary>
    public string BaseUrl { get; set; } = "";

    public int RequestTimeoutSeconds { get; set; } = 30;
    public int RetryCount { get; set; } = 2;
    public int RetryBaseDelayMs { get; set; } = 500;

    public int CircuitBreakerFailureThreshold { get; set; } = 3;
    public int CircuitBreakerSamplingDurationSeconds { get; set; } = 30;
    public int CircuitBreakerBreakDurationSeconds { get; set; } = 30;
}
