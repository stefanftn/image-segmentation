using ImageSeg.Infrastructure.Persistence;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;

namespace ImageSeg.Tests;

/// <summary>
/// Spins up the real app (Program.cs, unmodified) against an isolated in-memory SQLite
/// database instead of the real Postgres/MinIO/AI-sidecar dependencies, which don't exist in
/// a test run. One instance per test CLASS (via IClassFixture&lt;TestWebApplicationFactory&gt;) -
/// each gets its own SQLite connection, so test classes never see each other's data; tests
/// within the same class share it, which is why every test below uses a fresh
/// Guid.NewGuid()-based email rather than a fixed one.
/// </summary>
public sealed class TestWebApplicationFactory : WebApplicationFactory<Program>
{
    private SqliteConnection? _connection;

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");

        builder.ConfigureAppConfiguration((_, config) =>
        {
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                // A real, valid signing key is required - JwtTokenService refuses to start
                // without one (by design, see back/README.md). Distinct from the dev key in
                // appsettings.json so it's obviously a test artifact if it ever leaks into a log.
                ["Authentication:Jwt:SigningKey"] = "test-only-signing-key-do-not-reuse-anywhere-32chars-min",
                ["Authentication:Jwt:Issuer"] = "ImageSeg.Tests",
                ["Authentication:Jwt:Audience"] = "ImageSeg.Tests",
                // Google left unset (default empty) so AddGoogle is never registered - matches
                // production-when-unconfigured exactly, and GoogleLoginTests relies on this.

                // High enough that no auth test suite could realistically trip it - rate
                // limiting itself isn't what these tests are checking, and the limiter
                // partitions anonymous calls by remote IP, which every TestServer request
                // shares, so the real limits would make later tests flaky rather than testing
                // anything meaningful.
                ["RateLimiting:WritePermitLimit"] = "100000",
                ["RateLimiting:ReadPermitLimit"] = "100000",
            });
        });

        builder.ConfigureServices(services =>
        {
            // Swap Postgres for SQLite in-memory. Removing only the DbContextOptions<AppDbContext>
            // descriptor is NOT enough: EF Core 8+ aggregates EVERY registered
            // IDbContextOptionsConfiguration<AppDbContext> when building the final options (this
            // is what lets AddDbContext compose across multiple calls, e.g. for pooling/keyed
            // scenarios) - so AddImageSegInfrastructure's original UseNpgsql(...) configuration
            // stays registered and runs ALONGSIDE our UseSqlite(...) one unless removed
            // explicitly too. Leaving it in produces exactly this: "Multiple relational database
            // provider configurations found" - both providers' relational extensions end up
            // attached to the same built DbContextOptions, because both configuration actions
            // ran against it in sequence.
            var descriptorsToRemove = services.Where(d =>
                d.ServiceType == typeof(DbContextOptions<AppDbContext>) ||
                d.ServiceType == typeof(DbContextOptions) ||
                d.ServiceType == typeof(AppDbContext) ||
                d.ServiceType == typeof(IDbContextOptionsConfiguration<AppDbContext>)
            ).ToList();

            foreach (var descriptor in descriptorsToRemove)
            {
                services.Remove(descriptor);
            }

            // A single open connection for the lifetime of this factory - SQLite's
            // ":memory:" database only exists as long as at least one connection to it stays
            // open, and EF needs the same open connection reused, not one per DbContext.
            _connection = new SqliteConnection("DataSource=:memory:");
            _connection.Open();

            services.AddDbContext<AppDbContext>(options => options.UseSqlite(_connection));

            // TaskPoller / StaleTaskSweeperWorker are irrelevant to auth tests and would
            // otherwise start polling a database that has no ImageTasks and no real sidecar
            // to call - pure noise. Every IHostedService in this app happens to be one of
            // those two, so removing the whole category is safe and simpler than naming them.
            services.RemoveAll<IHostedService>();
        });
    }

    /// <summary>
    /// Call once per test class before the first request - creates the schema from the EF
    /// model directly (SQLite has no migration files of its own; EnsureCreated builds tables
    /// straight from the model, which is enough for auth tests that never touch a real
    /// migration-dependent feature).
    /// </summary>
    public async Task InitializeDatabaseAsync()
    {
        using var scope = Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        await db.Database.EnsureCreatedAsync();
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing) _connection?.Dispose();
    }
}
