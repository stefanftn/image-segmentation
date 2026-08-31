using Microsoft.Extensions.Options;

namespace ImageSeg.Application.Images.Services;

/// <summary>Upload:*  - every threshold configurable, nothing hardcoded in the validation path.</summary>
public sealed class UploadOptions
{
    public const string SectionName = "Upload";

    public long MaxFileSizeBytes { get; set; } = 10 * 1024 * 1024;

    /// <summary>Comma-separated in config, e.g. "image/png,image/jpeg,image/webp".</summary>
    public string AllowedContentTypes { get; set; } = "image/png,image/jpeg,image/webp";

    public IReadOnlySet<string> AllowedContentTypeSet =>
        AllowedContentTypes
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(x => x.ToLowerInvariant())
            .ToHashSet();
}

public sealed record UploadValidationResult(bool IsValid, string? Error, string? DetectedContentType)
{
    public static UploadValidationResult Ok(string contentType) => new(true, null, contentType);
    public static UploadValidationResult Fail(string error) => new(false, error, null);
}

/// <summary>
/// Magic-byte content sniffing, run BEFORE any storage or DB call so an invalid file never
/// consumes MinIO bandwidth. The client-supplied Content-Type header and filename extension are
/// both trivially spoofable, so neither is trusted on its own: the final decision comes from the
/// leading bytes of the stream, with the header used only as a cheap first rejection.
/// </summary>
public sealed class UploadValidator
{
    private readonly UploadOptions _options;

    public UploadValidator(IOptions<UploadOptions> options) => _options = options.Value;

    public async Task<UploadValidationResult> ValidateAsync(Stream stream, long length, string? declaredContentType, CancellationToken ct)
    {
        if (length <= 0)
            return UploadValidationResult.Fail("Empty upload.");

        if (length > _options.MaxFileSizeBytes)
            return UploadValidationResult.Fail($"File exceeds the maximum allowed size of {_options.MaxFileSizeBytes} bytes.");

        var allowed = _options.AllowedContentTypeSet;

        if (!string.IsNullOrWhiteSpace(declaredContentType) &&
            !allowed.Contains(declaredContentType.Split(';')[0].Trim().ToLowerInvariant()))
        {
            return UploadValidationResult.Fail($"Content type '{declaredContentType}' is not allowed.");
        }

        var header = new byte[12];
        var read = await ReadExactlyAsync(stream, header, ct);
        if (stream.CanSeek) stream.Position = 0;

        var sniffed = Sniff(header.AsSpan(0, read));
        if (sniffed is null)
            return UploadValidationResult.Fail("File content does not match any supported image format.");

        if (!allowed.Contains(sniffed))
            return UploadValidationResult.Fail($"Detected content type '{sniffed}' is not allowed.");

        return UploadValidationResult.Ok(sniffed);
    }

    /// <summary>Magic-byte detection for the formats in the default allow-list.</summary>
    private static string? Sniff(ReadOnlySpan<byte> b)
    {
        // PNG: 89 50 4E 47 0D 0A 1A 0A
        if (b.Length >= 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47 &&
            b[4] == 0x0D && b[5] == 0x0A && b[6] == 0x1A && b[7] == 0x0A)
            return "image/png";

        // JPEG: FF D8 FF
        if (b.Length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF)
            return "image/jpeg";

        // WEBP: "RIFF" .... "WEBP"
        if (b.Length >= 12 &&
            b[0] == 0x52 && b[1] == 0x49 && b[2] == 0x46 && b[3] == 0x46 &&
            b[8] == 0x57 && b[9] == 0x45 && b[10] == 0x42 && b[11] == 0x50)
            return "image/webp";

        return null;
    }

    private static async Task<int> ReadExactlyAsync(Stream stream, byte[] buffer, CancellationToken ct)
    {
        var total = 0;
        while (total < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(total), ct);
            if (read == 0) break;
            total += read;
        }
        return total;
    }
}
