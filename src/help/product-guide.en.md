## What it is

AI Education Reader is a local-first workspace for reading PDFs, discussing material with an AI model, and turning useful answers into reusable study cards, notes, and quizzes.

Your chats, files, reading progress, prompts, and study data stay in this browser. The app has no relay server. When you send a message, only the selected text and images are sent directly to the API service you configured.

## Start with a PDF

Choose **Import PDF** or open **Files** from the sidebar. The reader supports page-by-page and continuous scrolling, zoom below or above 100%, page notes, native bookmarks, manual chapters, and AI-assisted outline detection.

Use **Add to chat** to attach the current page, a chapter, several chapters, or a custom page range. Large selections show a warning before processing.

## Chats and routes

Create a chat, then ask questions about your material. Routes let you branch from an earlier answer without losing the main path. The route and mode controls above the conversation show which path and chat mode are active.

Quick follow-ups appear below model answers and wrap onto additional rows when needed. Select any part of a rendered answer to copy its original Markdown or LaTeX source; the full-source copy action is also available.

## Study cards and outputs

Save a model answer—or a marked selection—as a study card. You can choose a one-to-five-star rating while saving and change it later in the Learning Center. Card marks and message marks use the same stored data, so changes stay synchronized.

Study outputs include editable notes and quizzes. Every saved item keeps a source snapshot and, when the source still exists, a link back to the original chat or PDF page.

## Prompts

Prompt management separates chat modes, study-output templates, quick follow-ups, and system protocols. Built-in prompts are protected: copying one creates a local version that you can edit, disable, or restore without changing historical snapshots.

AI outline detection uses its own prompt and model effort. It does not change the reasoning setting used for normal chat sessions.

## Settings, backup, and privacy

Open **Settings** to configure your API base URL, API key, model, vision capability, theme, language, and PDF reading mode. Your API key is stored locally and is never included in backups.

Complete ZIP backups include chats, attachments, PDFs, notes, branches, prompts, study cards, and interface preferences. Large binaries are streamed as separate ZIP entries to avoid the high memory usage caused by Base64 JSON exports. Existing ZIP and JSON backups remain importable.

Because browser storage can be cleared by the browser or operating system, export a backup periodically—especially before clearing site data or moving to another browser.
