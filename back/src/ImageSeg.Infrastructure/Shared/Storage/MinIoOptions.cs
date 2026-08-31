namespace ImageSeg.Infrastructure.Shared.Storage;

/// <summary>Storage:MinIO:*  (spec §6).</summary>
public sealed class MinIoOptions
{
    public const string SectionName = "Storage:MinIO";

    public string Endpoint { get; set; } = "minio:9000";
    public string AccessKey { get; set; } = "minioadmin";
    public string SecretKey { get; set; } = "minioadmin";
    public string Bucket { get; set; } = "images";
    public bool UseSsl { get; set; } = false;

    /// <summary>
    /// Host the *browser* must be able to reach. The in-cluster endpoint (minio:9000) is not
    /// resolvable from the user's machine, so presigned URLs are signed against this origin
    /// instead - see MinIoStorageService for why this cannot be a post-hoc string rewrite on an
    /// already-signed URL (SigV4 signs the Host header).
    /// </summary>
    public string? PublicEndpoint { get; set; }
}
