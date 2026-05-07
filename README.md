# Deduction Deck

A browser-based Clue / Cluedo probability calculator for tracking card ownership, suggestions, disprovers, and envelope odds.

Repository: <https://github.com/Mike7154/deduction-deck>

## What it does

- Exact probability solver for valid deals that match your evidence.
- Card matrix for `yes` / `no` / unknown ownership.
- Suggestion logging for:
  - nobody disproved
  - someone disproved but the shown card is unknown
  - exact card shown
- Automatic deductions without needing to click "Apply deductions".
- Optional "Apply deductions" button to write solver-known `0%` / `100%` facts into the visible grid.
- Local per-email game separation in browser storage.
- Docker / Unraid friendly static web app.

## Quick start with Docker image

If the GitHub Container Registry package is public, the easiest install is:

```bash
docker run -d \
  --name deduction-deck \
  -p 8080:80 \
  --restart unless-stopped \
  ghcr.io/mike7154/deduction-deck:latest
```

Then open:

```text
http://localhost:8080
```

Or from another device on your network:

```text
http://<server-ip>:8080
```

## Docker Compose

Create `docker-compose.yml`:

```yaml
services:
  deduction-deck:
    image: ghcr.io/mike7154/deduction-deck:latest
    container_name: deduction-deck
    restart: unless-stopped
    ports:
      - "8080:80"
```

Start it:

```bash
docker compose up -d
```

## Unraid install

In Unraid Docker UI, add a new container with:

```text
Name: deduction-deck
Repository: ghcr.io/mike7154/deduction-deck:latest
Network Type: bridge
Container Port: 80
Host Port: 8080
Restart Policy: unless-stopped
```

Then open:

```text
http://<unraid-ip>:8080
```

If Unraid cannot pull the image, check that the GitHub package is public or log Unraid/Docker into GHCR.

## Build locally from source

```bash
git clone https://github.com/Mike7154/deduction-deck.git
cd deduction-deck
npm install
npm run dev
```

Vite will print the local development URL, usually:

```text
http://localhost:5173
```

## Production build from source

```bash
git clone https://github.com/Mike7154/deduction-deck.git
cd deduction-deck
npm install
npm run build
npm run preview
```

## Build your own Docker image

```bash
git clone https://github.com/Mike7154/deduction-deck.git
cd deduction-deck
docker build -t deduction-deck .
docker run -d --name deduction-deck -p 8080:80 --restart unless-stopped deduction-deck
```

## Updating

### Docker / Unraid

Pull the newest image and recreate the container:

```bash
docker pull ghcr.io/mike7154/deduction-deck:latest
docker stop deduction-deck
docker rm deduction-deck
docker run -d --name deduction-deck -p 8080:80 --restart unless-stopped ghcr.io/mike7154/deduction-deck:latest
```

With Compose:

```bash
docker compose pull
docker compose up -d
```

### Source checkout

```bash
git pull
npm install
npm run build
```

## Data storage note

Game data and email-separated accounts are stored in the browser's local storage on the device using the app. Updating the Docker image or source code should not delete browser data, but clearing site data/browser storage will.
