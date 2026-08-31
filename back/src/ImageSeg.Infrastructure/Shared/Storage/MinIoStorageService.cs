using ImageSeg.Domain.Shared.Interfaces;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Minio;
using Minio.DataModel.Args;
using Minio.Exceptions;

namespace ImageSeg.Infrastructure.Shared.Storage;

/// <summary>
/// S3-compatible implementation of IStorageService (spec §6) - the only backend that ships in
/// this system. IStorageService itself stays an interface, matching ISegmentationClient, so a
/// second backend would cost a new implementation, not a rewrite.
/// </summary>
public sealed class MinIoStorageService : IStorageService
{
    private readonly IMinioClient _client;
    private readonly IMinioClient _presignClient;
    private readonly MinIoOptions _options;
    private readonly ILogger<MinIoStorageService> _logger;

    public MinIoStorageService(
        IMinioClient client,
        [FromKeyedServices("presign")] IMinioClient presignClient,
        IOptions<MinIoOptions> options,
        ILogger<MinIoStorageService> logger)
    {
        _client = client;
        _presignClient = presignClient;
        _options = options.Value;
        _logger = logger;
    }

    public async Task<string> UploadAsync(Stream content, string key, CancellationToken ct)
    {
        long size;
        Stream source = content;

        if (content.CanSeek)
        {
            size = content.Length - content.Position;
        }
        else
        {
            var buffer = new MemoryStream();
            await content.CopyToAsync(buffer, ct);
            buffer.Position = 0;
            source = buffer;
            size = buffer.Length;
        }

        await _client.PutObjectAsync(new PutObjectArgs()
            .WithBucket(_options.Bucket)
            .WithObject(key)
            .WithStreamData(source)
            .WithObjectSize(size)
            .WithContentType(GuessContentType(key)), ct);

        _logger.LogInformation("Uploaded {Key} to MinIO bucket {Bucket} ({Size} bytes).", key, _options.Bucket, size);
        return key;
    }

    public async Task<Stream> DownloadAsync(string key, CancellationToken ct)
    {
        var ms = new MemoryStream();
        await _client.GetObjectAsync(new GetObjectArgs()
            .WithBucket(_options.Bucket)
            .WithObject(key)
            .WithCallbackStream(async (stream, token) => await stream.CopyToAsync(ms, token)), ct);

        ms.Position = 0;
        return ms;
    }

    public Task DeleteAsync(string key, CancellationToken ct)
        => _client.RemoveObjectAsync(new RemoveObjectArgs().WithBucket(_options.Bucket).WithObject(key), ct);

    public async Task<bool> ExistsAsync(string key, CancellationToken ct)
    {
        try
        {
            await _client.StatObjectAsync(new StatObjectArgs().WithBucket(_options.Bucket).WithObject(key), ct);
            return true;
        }
        catch (ObjectNotFoundException) { return false; }
        catch (BucketNotFoundException) { return false; }
    }

    /// <summary>
    /// Signed by <c>_presignClient</c> - a MinIO client configured against the browser-reachable
    /// endpoint from the start, not the internal one. SigV4 bakes the Host header into the
    /// signature, so the signing client must already target the host the browser will actually
    /// hit; rewriting the URL's host after signing invalidates the signature.
    /// </summary>
    public async Task<string> GetPresignedDownloadUrlAsync(string key, TimeSpan expiry, CancellationToken ct)
    {
        return await _presignClient.PresignedGetObjectAsync(new PresignedGetObjectArgs()
            .WithBucket(_options.Bucket)
            .WithObject(key)
            .WithExpiry((int)expiry.TotalSeconds));
    }

    private static string GuessContentType(string key) => Path.GetExtension(key).ToLowerInvariant() switch
    {
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".webp" => "image/webp",
        _ => "application/octet-stream"
    };
}
