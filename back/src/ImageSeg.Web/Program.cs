using System.Threading.RateLimiting;
using ImageSeg.Application.Images.Interfaces;
using ImageSeg.Application.Images.Processing;
using ImageSeg.Application.Images.Services;
using ImageSeg.Application.MaskGroups.Interfaces;
using ImageSeg.Application.MaskGroups.Services;
using ImageSeg.Domain.Identity.Entities;
using ImageSeg.Infrastructure;
using ImageSeg.Infrastructure.Persistence;
using ImageSeg.Web.Identity;
using ImageSeg.Web.Images.Hubs;
using ImageSeg.Web.Shared.Middleware;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.AspNetCore.HttpOverrides;
using Prometheus;

var builder = WebApplication.CreateBuilder(args);

// -----------------------------------------------------------------------------------------
// Spec §12: migrations are applied as an EXPLICIT deploy step, not automatically at process
// startup. Rationale: this system is meant to scale the Web project to multiple replicas
// (spec §11's "web" service), and N replicas each racing to auto-migrate on boot is exactly
// the kind of failure mode a one-person-operable system should not have to debug at 2am.
// Instead, `dotnet ImageSeg.Web.dll --migrate` applies pending migrations and exits - run this
// once, before starting/rolling the "web" service, as a distinct CI/CD step or a one-shot
// docker compose job (see deploy/docker-compose.yml).
// -----------------------------------------------------------------------------------------
if (args.Contains("--migrate"))
{
    var migrationBuilder = WebApplication.CreateBuilder();
    migrationBuilder.Services.AddDbContext<AppDbContext>(o =>
        o.UseNpgsql(migrationBuilder.Configuration.GetConnectionString("Postgres")));

    using var migrationHost = migrationBuilder.Build();
    using var scope = migrationHost.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    await db.Database.MigrateAsync();
    Console.WriteLine("Migrations applied successfully.");
    return;
}

builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    options.KnownNetworks.Clear();
    options.KnownProxies.Clear();
});

// ---- Infrastructure (Postgres, MinIO, AI sidecar clients) --------------------------------
builder.Services.AddImageSegInfrastructure(builder.Configuration);

// ---- Identity (spec §3) - real auth from day one, no dev-token endpoint anywhere ----------
// UserManager/SignInManager/RoleManager and the EF stores below still do all the
// password/lockout/2FA/external-login bookkeeping - only the credential handed back to the
// browser is a JWT (JwtTokenService) instead of the framework's default cookie. That choice is
// driven by the frontend this backend serves: a separately-hosted static app whose fetch calls
// never set `credentials: "include"`, so a cross-origin cookie could never actually reach it.
// Spec §3 explicitly leaves cookie vs. JWT-bearer to "how the frontend actually consumes this."
builder.Services
    .AddIdentity<ApplicationUser, IdentityRole>(options =>
    {
        options.SignIn.RequireConfirmedAccount = false; // flip on once real email delivery exists
        options.Password.RequiredLength = 8;
    })
    .AddEntityFrameworkStores<AppDbContext>()
    .AddDefaultTokenProviders(); // enables TOTP 2FA (Google Authenticator / Authy compatible)

builder.Services.Configure<JwtOptions>(builder.Configuration.GetSection(JwtOptions.SectionName));
builder.Services.AddSingleton<JwtTokenService>();

var authenticationBuilder = builder.Services.AddAuthentication(options =>
{
    // Only the resolution defaults for the app's own [Authorize] surface change here - Identity's
    // own DefaultSignInScheme (Identity.External) is untouched, so the Google OAuth handshake's
    // temporary cookie (used only to carry state through the redirect to Google and back) keeps
    // working unmodified. This is the surgical version of the mistake fixed earlier in this
    // project: setting the *specific* Default*Scheme properties, pointed at a scheme that IS
    // actually registered below via AddJwtBearer, rather than the blanket DefaultScheme.
    options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
    options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
});

// TokenValidationParameters is built from JwtTokenService (via DI) rather than duplicated here,
// so there is exactly one place that knows the signing key/issuer/audience and one place that
// could get them out of sync with each other.
authenticationBuilder.AddJwtBearer(_ => { });
builder.Services.AddOptions<JwtBearerOptions>(JwtBearerDefaults.AuthenticationScheme)
    .Configure<JwtTokenService>((options, jwt) =>
    {
        options.TokenValidationParameters = jwt.BuildBearerValidationParameters();
    });

// Google is only registered as a scheme at all when real credentials are configured. This is
// not just tidiness: AuthenticationMiddleware checks every REMOTE scheme (anything implementing
// IAuthenticationRequestHandler, which Google's handler does, to intercept its callback path)
// on every single incoming request, not just requests actually bound for Google. Resolving that
// handler eagerly validates its options, and OAuthOptions.Validate() throws on an empty
// ClientId - so registering .AddGoogle(...) unconditionally with blank credentials breaks
// EVERY request in the app, not just Google sign-in, regardless of which scheme is default.
var googleClientId = builder.Configuration["Authentication:Google:ClientId"];
var googleClientSecret = builder.Configuration["Authentication:Google:ClientSecret"];

if (!string.IsNullOrWhiteSpace(googleClientId) && !string.IsNullOrWhiteSpace(googleClientSecret))
{
    authenticationBuilder.AddGoogle(options =>
    {
        options.ClientId = googleClientId;
        options.ClientSecret = googleClientSecret;
        options.SignInScheme = IdentityConstants.ExternalScheme;

        // Default is "/signin-google" - moved under /api/ so it lands on this same backend
        // through the reverse proxy's existing /api/ routing (see deploy/nginx-additions.conf),
        // instead of needing its own dedicated nginx location block that would have to be
        // remembered and duplicated for every future OAuth provider added later.
        options.CallbackPath = "/api/auth/signin-google";
    });
}
else
{
    // Not a startup failure: email/password auth (AuthController.Register/Login) works fine
    // without this. GET /api/auth/google/login will 404 until real credentials are set, which
    // is the correct behavior for an unconfigured provider.
    Console.WriteLine("[startup] Authentication:Google:ClientId/ClientSecret not set - Google sign-in is disabled.");
}

builder.Services.AddAuthorization();

// ---- Application services -----------------------------------------------------------------
builder.Services.AddScoped<IImageTaskService, ImageTaskService>();
builder.Services.AddScoped<IMaskGroupService, MaskGroupService>();
builder.Services.AddScoped<UploadValidator>();
builder.Services.AddScoped<ImageSeg.Application.Images.Processing.ITaskProcessor>(sp =>
{
    // Composes the decorator chain (spec §4.4):
    // LoggingProcessorDecorator -> RetryProcessorDecorator -> ImagePreprocessingDecorator -> AiInferenceProcessor.
    ImageSeg.Application.Images.Processing.ITaskProcessor pipeline = new AiInferenceProcessor(
        sp.GetRequiredService<ImageSeg.Domain.Shared.Interfaces.ISegmentationClient>(),
        sp.GetRequiredService<ImageSeg.Domain.Shared.Interfaces.IStorageService>(),
        sp.GetRequiredService<IImageTaskService>(),
        sp.GetRequiredService<InFlightLimiter>(),
        sp.GetRequiredService<ILogger<AiInferenceProcessor>>());

    pipeline = new ImagePreprocessingDecorator(
        pipeline,
        sp.GetRequiredService<ImageSeg.Domain.Shared.Interfaces.IStorageService>(),
        sp.GetRequiredService<IImageTaskService>(),
        sp.GetRequiredService<IOptions<ProcessorOptions>>(),
        sp.GetRequiredService<ILogger<ImagePreprocessingDecorator>>());

    pipeline = new RetryProcessorDecorator(
        pipeline,
        sp.GetRequiredService<IOptions<ProcessorOptions>>(),
        sp.GetRequiredService<ILogger<RetryProcessorDecorator>>());

    pipeline = new LoggingProcessorDecorator(pipeline, sp.GetRequiredService<ILogger<LoggingProcessorDecorator>>());

    return pipeline;
});

builder.Services.AddSingleton<InFlightLimiter>();
builder.Services.AddScoped<ITaskStatusNotifier, SignalRTaskStatusNotifier>();

builder.Services.Configure<PollerOptions>(builder.Configuration.GetSection(PollerOptions.SectionName));
builder.Services.Configure<ProcessorOptions>(builder.Configuration.GetSection(ProcessorOptions.SectionName));
builder.Services.Configure<SweeperOptions>(builder.Configuration.GetSection(SweeperOptions.SectionName));
builder.Services.Configure<UploadOptions>(builder.Configuration.GetSection(UploadOptions.SectionName));
builder.Services.Configure<StorageOptions>(builder.Configuration.GetSection(StorageOptions.SectionName));

builder.Services.AddSingleton(TimeProvider.System);

// ---- Background services: TaskPoller + StaleTaskSweeperWorker (spec §4, §11's "web" service) ----
builder.Services.AddHostedService<TaskPoller>();
builder.Services.AddHostedService<StaleTaskSweeperWorker>();

// ---- SignalR (spec §5) ---------------------------------------------------------------------
builder.Services.AddSignalR();

// ---- CORS (spec §9) -------------------------------------------------------------------------
var allowedOrigins = (builder.Configuration["Cors:AllowedOrigins"] ?? "")
    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy => policy
        .WithOrigins(allowedOrigins)
        .AllowAnyHeader()
        .AllowAnyMethod()
        .AllowCredentials()); // harmless with Bearer-token auth (the frontend never sends
                              // cookies), kept in case a future client needs cookie-based
                              // access - WithOrigins() below means this never combines with a
                              // wildcard origin, which is the actual browser restriction.
});

// ---- Rate limiting (spec §9) - two tiers: tight for writes, looser for reads ---------------
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    options.AddPolicy("writes", context => RateLimitPartition.GetFixedWindowLimiter(
        PartitionKey(context),
        _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = builder.Configuration.GetValue("RateLimiting:WritePermitLimit", 20),
            Window = TimeSpan.FromSeconds(builder.Configuration.GetValue("RateLimiting:WriteWindowSeconds", 60)),
            QueueLimit = 0
        }));

    // Reads get their own, much looser budget: the frontend now relies on SignalR pushes for
    // live updates rather than 2s polling, but /status is still hit on initial load and on
    // reconnect after a dropped WebSocket.
    options.AddPolicy("reads", context => RateLimitPartition.GetFixedWindowLimiter(
        PartitionKey(context),
        _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = builder.Configuration.GetValue("RateLimiting:ReadPermitLimit", 120),
            Window = TimeSpan.FromSeconds(builder.Configuration.GetValue("RateLimiting:ReadWindowSeconds", 60)),
            QueueLimit = 0
        }));
});

builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseMiddleware<CorrelationIdMiddleware>(); // spec §9 - first in the pipeline
app.UseForwardedHeaders();

// HTTP request metrics (imageseg_web request count/duration by method/code/route). As early as
// possible so timing covers the whole pipeline, not just what runs after it. Deliberately NOT
// gated behind CORS/auth: /metrics is scraped by Prometheus over the internal "imageseg" Docker
// network only (see deploy/docker-compose*.yml) - it is never reachable through the public
// reverse proxy, which has no location block for it (only /api/, /hubs/, and / are routed).
app.UseHttpMetrics();

app.UseCors();

app.UseAuthentication();
// Rate limiting reads context.User in PartitionKey (above), so it must run after
// UseAuthentication() populates it - otherwise every request, authenticated or not, would
// silently fall back to remote-IP partitioning and never actually key by user.
app.UseRateLimiter();
app.UseAuthorization();

app.MapControllers();

app.MapHub<TaskStatusHub>("/hubs/tasks");

// Process/GC/thread-pool metrics (dotnet_*) alongside the HTTP metrics from UseHttpMetrics()
// above and the custom Counters/Gauges TaskPoller and StaleTaskSweeperWorker register into the
// same DefaultRegistry. One combined exposition, scraped by Prometheus' "imageseg-web" job.
DotNetStats.Register(Metrics.DefaultRegistry);
app.MapMetrics();

app.Run();

static string PartitionKey(HttpContext context)
    // Prefer the authenticated user's own id over the connection's remote IP, so multiple
    // authenticated users behind the same NAT/proxy don't share one rate-limit bucket. JWTs
    // issued by JwtTokenService carry NameIdentifier, not a "name" claim, so Identity.Name is
    // never populated here - reading the claim directly is the correct check either way.
    => context.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value
       ?? context.Connection.RemoteIpAddress?.ToString()
       ?? "anonymous";

/// <summary>
/// Top-level statements generate an `internal` Program class by default, invisible outside
/// this assembly. This marker makes it `public partial` instead - purely so
/// ImageSeg.Tests can use `WebApplicationFactory&lt;Program&gt;` to spin up a real, in-memory
/// instance of this exact app for integration testing. No runtime behavior changes; this
/// compiles to nothing on its own.
/// </summary>
public partial class Program { }
