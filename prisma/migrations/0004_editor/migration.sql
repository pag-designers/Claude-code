-- CP3: editor projects, versions and exports (new tables only; nothing existing is touched).
CREATE TABLE "EditorProject" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL DEFAULT 'local',
    "name" TEXT NOT NULL,
    "clipId" TEXT,
    "videoId" TEXT,
    "data" TEXT NOT NULL,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "durationSec" REAL NOT NULL DEFAULT 0,
    "aspect" TEXT NOT NULL DEFAULT '9:16',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "EditorProject_updatedAt_idx" ON "EditorProject"("updatedAt");

CREATE TABLE "EditorVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "rev" INTEGER NOT NULL,
    "label" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'auto',
    "data" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EditorVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "EditorProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "EditorVersion_projectId_idx" ON "EditorVersion"("projectId");

CREATE TABLE "EditorExport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL DEFAULT 'local',
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "progress" REAL,
    "message" TEXT,
    "error" TEXT,
    "settings" TEXT NOT NULL DEFAULT '{}',
    "durationSec" REAL,
    "sizeBytes" INTEGER,
    "storageKeys" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);
CREATE INDEX "EditorExport_createdAt_idx" ON "EditorExport"("createdAt");
