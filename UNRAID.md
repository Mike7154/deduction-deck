# Unraid / Docker deployment notes

## Option A: GitHub Container Registry + Unraid Docker UI

1. Push this repo to GitHub.
2. Let the `Build and publish Docker image` GitHub Action finish.
3. In GitHub, open the package page and make the package public if your Unraid server will not log into GHCR.
4. In Unraid: Docker tab -> Add Container.
5. Use these values:

```text
Name: deduction-deck
Repository: ghcr.io/<your-github-owner>/deduction-deck:latest
Network Type: bridge
Container Port: 80
Host Port: 8080
Restart Policy: unless-stopped
```

Then open:

```text
http://<unraid-ip>:8080
```

## Option B: Unraid Compose Manager

Copy `docker-compose.example.yml`, replace `YOUR_GITHUB_OWNER`, and deploy it with the Compose Manager plugin.

## Option C: Build directly on Unraid

```bash
git clone https://github.com/<your-github-owner>/deduction-deck.git
cd deduction-deck
docker build -t deduction-deck .
docker run -d --name deduction-deck -p 8080:80 --restart unless-stopped deduction-deck
```

## Updating

After each push to `main`, GitHub Actions publishes a new `latest` image. On Unraid, update the container from the Docker tab, or use your existing automation/watchtower if configured.
