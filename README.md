# Deduction Deck

A web-based Cluedo / Clue probability calculator inspired by the original Excel workbook.

## Features

- Exact possible-deal solver when the game state is small enough to enumerate.
- Known `yes` / `no` card ownership matrix.
- Suggestion logging: nobody disproved, unknown disprover card, or exact shown card.
- Automatic hard deductions from all valid deals.
- Separate behavior-hint tracking for whether players tend to suggest cards they own.
- Local browser storage MVP; ready for Docker hosting.

## Local development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Docker

```bash
docker build -t deduction-deck .
docker run -d --name deduction-deck -p 8080:80 --restart unless-stopped deduction-deck
```

## GitHub Container Registry

The included GitHub Action publishes an image to:

```text
ghcr.io/<owner>/<repo>:latest
```

On Unraid, use that image with container port `80` mapped to any host port you want, e.g. `8080`.
