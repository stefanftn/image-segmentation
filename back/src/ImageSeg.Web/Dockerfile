# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

COPY ImageSeg.sln .
COPY src/ImageSeg.Domain/ImageSeg.Domain.csproj src/ImageSeg.Domain/
COPY src/ImageSeg.Application/ImageSeg.Application.csproj src/ImageSeg.Application/
COPY src/ImageSeg.Infrastructure/ImageSeg.Infrastructure.csproj src/ImageSeg.Infrastructure/
COPY src/ImageSeg.Web/ImageSeg.Web.csproj src/ImageSeg.Web/
RUN dotnet restore src/ImageSeg.Web/ImageSeg.Web.csproj

COPY src/ src/
RUN dotnet publish src/ImageSeg.Web/ImageSeg.Web.csproj -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS runtime
WORKDIR /app
COPY --from=build /app .

ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080

ENTRYPOINT ["dotnet", "ImageSeg.Web.dll"]
