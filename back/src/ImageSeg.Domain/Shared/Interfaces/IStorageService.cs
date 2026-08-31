namespace ImageSeg.Domain.Shared.Interfaces;

/// <summary>
/// Spec §6. Only one implementation ships (MinIoStorageService, Infrastructure) but this stays
/// an interface for the same reason ISegmentationClient does - a second backend should be
/// addable without a rewrite.
/// </summary>
public interface IStorageService
{
    /// <summary>Uploads <paramref name="content"/> and returns the storage key/path to persist.</summary>
    Task<string> UploadAsync(Stream content, string key, CancellationToken ct);

    Task<Stream> DownloadAsync(string key, CancellationToken ct);

    Task DeleteAsync(string key, CancellationToken ct);

    Task<bool> ExistsAsync(string key, CancellationToken ct);

    /// <summary>
    /// Time-limited direct-download URL so the browser can fetch results/originals directly
    /// from MinIO without proxying through the Web process (spec §6).
    /// </summary>
    Task<string> GetPresignedDownloadUrlAsync(string key, TimeSpan expiry, CancellationToken ct);
}

public static class StorageProviders
{
    public const string MinIO = "MinIO";
}
