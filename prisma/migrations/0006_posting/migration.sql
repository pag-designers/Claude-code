-- CP5: connected social accounts, posts (scheduled / published) and per-day quota counters (new tables only).
CREATE TABLE "SocialAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL DEFAULT 'local',
    "platform" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "handle" TEXT,
    "avatarUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "statusMessage" TEXT,
    "scopes" TEXT NOT NULL DEFAULT '[]',
    "info" TEXT NOT NULL DEFAULT '{}',
    "connectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "SocialAccount_platform_externalId_key" ON "SocialAccount"("platform", "externalId");

CREATE TABLE "Post" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL DEFAULT 'local',
    "accountId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "clipId" TEXT,
    "exportId" TEXT,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "scheduledAt" DATETIME,
    "publishedAt" DATETIME,
    "nextAttemptAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "fields" TEXT NOT NULL,
    "media" TEXT,
    "mediaKey" TEXT NOT NULL,
    "fixedMediaKey" TEXT,
    "autoFix" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "result" TEXT,
    "stats" TEXT,
    "groupId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "Post_status_scheduledAt_idx" ON "Post"("status", "scheduledAt");
CREATE INDEX "Post_accountId_idx" ON "Post"("accountId");
CREATE INDEX "Post_clipId_idx" ON "Post"("clipId");

CREATE TABLE "QuotaUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL DEFAULT 'local',
    "accountId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "units" INTEGER NOT NULL DEFAULT 0,
    "posts" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "QuotaUsage_accountId_day_key" ON "QuotaUsage"("accountId", "day");
