using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.Extensions.Configuration;

namespace ImageSeg.Infrastructure.Persistence;

/// <summary>
/// Lets <c>dotnet ef migrations add &lt;Name&gt;</c> and <c>dotnet ef database update</c> run
/// from ImageSeg.Web (spec §12) without needing the full app host to start. Reads the same
/// ConnectionStrings:Postgres value the running app uses, falling back to a local default so a
/// fresh clone can generate migrations before docker compose is even up.
/// </summary>
public sealed class AppDbContextFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var configuration = new ConfigurationBuilder()
            .SetBasePath(Directory.GetCurrentDirectory())
            .AddJsonFile("appsettings.json", optional: true)
            .AddEnvironmentVariables()
            .Build();

        var connectionString = configuration.GetConnectionString("Postgres")
            ?? "Host=localhost;Port=5432;Database=imageseg;Username=imageseg;Password=imageseg";

        var builder = new DbContextOptionsBuilder<AppDbContext>();
        builder.UseNpgsql(connectionString, npgsql =>
            npgsql.MigrationsHistoryTable("__EFMigrationsHistory"));

        return new AppDbContext(builder.Options);
    }
}
