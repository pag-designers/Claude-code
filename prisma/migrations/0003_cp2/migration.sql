-- CP2: non-destructive ADD COLUMNs + new tables (no table redefinitions, so no cascade risk).
ALTER TABLE "Video" ADD COLUMN "subtitleRev" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Clip" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'clip';
ALTER TABLE "Clip" ADD COLUMN "runId" TEXT;
ALTER TABLE "Clip" ADD COLUMN "captionStyleId" TEXT NOT NULL DEFAULT 'clean-pop';
ALTER TABLE "Clip" ADD COLUMN "reframeMode" TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE "Clip" ADD COLUMN "layout" TEXT;
ALTER TABLE "Clip" ADD COLUMN "subtitleRev" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "MomentRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL DEFAULT 'local',
    "videoId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "options" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'running',
    "found" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);
CREATE INDEX "MomentRun_videoId_idx" ON "MomentRun"("videoId");

CREATE TABLE "CaptionStylePreset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL DEFAULT 'local',
    "brandKitId" TEXT,
    "name" TEXT NOT NULL,
    "spec" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "ChatThread" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL DEFAULT 'local',
    "videoId" TEXT NOT NULL,
    "clipId" TEXT,
    "title" TEXT NOT NULL DEFAULT 'New chat',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "ChatThread_videoId_idx" ON "ChatThread"("videoId");

CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "citations" TEXT NOT NULL DEFAULT '[]',
    "actions" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ChatMessage_threadId_idx" ON "ChatMessage"("threadId");

CREATE TABLE "Marker" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL DEFAULT 'local',
    "videoId" TEXT NOT NULL,
    "atSec" REAL NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "Marker_videoId_idx" ON "Marker"("videoId");
