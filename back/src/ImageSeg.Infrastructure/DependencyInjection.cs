using ImageSeg.Domain.Images.Interfaces;
using ImageSeg.Domain.MaskGroups.Interfaces;
using ImageSeg.Domain.Shared.Interfaces;
using ImageSeg.Infrastructure.Images.Repositories;
using ImageSeg.Infrastructure.MaskGroups.Repositories;
using ImageSeg.Infrastructure.Persistence;
using ImageSeg.Infrastructure.Shared.Ai;
using ImageSeg.Infrastructure.Shared.Storage;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Minio;
using Polly;
using Polly.CircuitBreaker;
using Polly.Timeout;

namespace ImageSeg.Infrastructure;

/// <summary>
/// Wiring extension methods called from Web/Program.cs, the sole composition root (spec §1).
/// Program.cs is still the only place that ever *sees* every concrete class end to end; these
/// methods just keep that file from being one enormous block of registration code.
/// </summary>
public static class DependencyInjection
{
    public static IServiceCollection AddImageSegInfrastructure(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddDbContext<AppDbContext>(options =>
            options.UseNpgsql(configuration.GetConnectionString("Postgres"),
                npgsql => npgsql.MigrationsHistoryTable("__EFMigrationsHistory")));

        services.AddScoped<IImageTaskRepository, ImageTaskRepository>();
        services.AddScoped<IMaskGroupRepository, MaskGroupRepository>();

        services.AddStorage(configuration);
        services.AddAiSidecar(configuration);

        return services;
    }

    private static IServiceCollection AddStorage(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<MinIoOptions>(configuration.GetSection(MinIoOptions.SectionName));

        services.AddSingleton(sp =>
        {
            var o = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<MinIoOptions>>().Value;
            return (IMinioClient)new MinioClient()
                .WithEndpoint(o.Endpoint)
                .WithCredentials(o.AccessKey, o.SecretKey)
                .WithSSL(o.UseSsl)
                .Build();
        });

        // Separate, keyed client whose endpoint is the browser-reachable host: presigned URLs
        // are signed with SigV4, which bakes the Host header into the signature, so the signing
        // client must already target the origin the browser will actually hit.
        services.AddKeyedSingleton("presign", (sp, _) =>
        {
            var o = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<MinIoOptions>>().Value;
            var publicEndpoint = string.IsNullOrWhiteSpace(o.PublicEndpoint) ? o.Endpoint : o.PublicEndpoint;
            var useSsl = o.UseSsl || publicEndpoint.StartsWith("https://", StringComparison.OrdinalIgnoreCase);
            var hostOnly = publicEndpoint
                .Replace("https://", "", StringComparison.OrdinalIgnoreCase)
                .Replace("http://", "", StringComparison.OrdinalIgnoreCase);

            return (IMinioClient)new MinioClient()
                .WithEndpoint(hostOnly)
                .WithCredentials(o.AccessKey, o.SecretKey)
                .WithSSL(useSsl)
                .Build();
        });

        services.AddScoped<IStorageService, MinIoStorageService>();

        return services;
    }

    private static IServiceCollection AddAiSidecar(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<AiSidecarOptions>(configuration.GetSection(AiSidecarOptions.SectionName));
        var o = configuration.GetSection(AiSidecarOptions.SectionName).Get<AiSidecarOptions>() ?? new AiSidecarOptions();

        services.AddHttpClient(LocalSegmentationClient.SegmentClientName, client =>
        {
            client.BaseAddress = new Uri(o.BaseUrl);
            client.Timeout = Timeout.InfiniteTimeSpan; // Polly's AddTimeout owns the real timeout
        }).AddResilienceHandler("segment", builder => builder
            .AddTimeout(TimeSpan.FromSeconds(o.RequestTimeoutSeconds))
            .AddRetry(new Polly.Retry.RetryStrategyOptions<HttpResponseMessage>
            {
                MaxRetryAttempts = o.RetryCount,
                Delay = TimeSpan.FromMilliseconds(o.RetryBaseDelayMs),
                BackoffType = DelayBackoffType.Exponential
            })
            .AddCircuitBreaker(new CircuitBreakerStrategyOptions<HttpResponseMessage>
            {
                FailureRatio = 0.5,
                SamplingDuration = TimeSpan.FromSeconds(o.CircuitBreakerSamplingDurationSeconds),
                MinimumThroughput = o.CircuitBreakerFailureThreshold,
                BreakDuration = TimeSpan.FromSeconds(o.CircuitBreakerBreakDurationSeconds)
            }));

        services.AddHttpClient(LocalSegmentationClient.RegionsClientName, client =>
        {
            client.BaseAddress = new Uri(o.BaseUrl);
            client.Timeout = Timeout.InfiniteTimeSpan;
        }).AddResilienceHandler("regions", builder => builder
            .AddTimeout(TimeSpan.FromSeconds(o.RegionsRequestTimeoutSeconds))
            .AddRetry(new Polly.Retry.RetryStrategyOptions<HttpResponseMessage>
            {
                MaxRetryAttempts = o.RegionsRetryCount,
                Delay = TimeSpan.FromMilliseconds(o.RegionsRetryBaseDelayMs),
                BackoffType = DelayBackoffType.Exponential
            })
            .AddCircuitBreaker(new CircuitBreakerStrategyOptions<HttpResponseMessage>
            {
                FailureRatio = 0.5,
                SamplingDuration = TimeSpan.FromSeconds(o.CircuitBreakerSamplingDurationSeconds),
                MinimumThroughput = o.CircuitBreakerFailureThreshold,
                BreakDuration = TimeSpan.FromSeconds(o.CircuitBreakerBreakDurationSeconds)
            }));

        services.AddHttpClient(ColabRegionsClient.ClientName, client =>
        {
            if (!string.IsNullOrWhiteSpace(o.Colab.BaseUrl))
                client.BaseAddress = new Uri(o.Colab.BaseUrl);
            client.Timeout = Timeout.InfiniteTimeSpan;
        }).AddResilienceHandler("colab-regions", builder => builder
            .AddTimeout(TimeSpan.FromSeconds(o.Colab.RequestTimeoutSeconds))
            .AddRetry(new Polly.Retry.RetryStrategyOptions<HttpResponseMessage>
            {
                MaxRetryAttempts = o.Colab.RetryCount,
                Delay = TimeSpan.FromMilliseconds(o.Colab.RetryBaseDelayMs),
                BackoffType = DelayBackoffType.Exponential
            })
            .AddCircuitBreaker(new CircuitBreakerStrategyOptions<HttpResponseMessage>
            {
                FailureRatio = 0.5,
                SamplingDuration = TimeSpan.FromSeconds(o.Colab.CircuitBreakerSamplingDurationSeconds),
                MinimumThroughput = o.Colab.CircuitBreakerFailureThreshold,
                BreakDuration = TimeSpan.FromSeconds(o.Colab.CircuitBreakerBreakDurationSeconds)
            }));

        services.AddScoped<LocalSegmentationClient>();
        services.AddScoped<ColabRegionsClient>();
        services.AddScoped<ISegmentationClient, RoutingSegmentationClient>();

        return services;
    }
}
