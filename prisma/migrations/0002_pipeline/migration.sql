-- Non-destructive: plain ADD COLUMN (Prisma's table-redefine form would DROP TABLE "Video" and, with
-- foreign keys on, cascade-delete clips inside the migration transaction).
ALTER TABLE "Video" ADD COLUMN "stage" TEXT;
ALTER TABLE "Video" ADD COLUMN "progress" REAL;
ALTER TABLE "Video" ADD COLUMN "error" TEXT;
ALTER TABLE "Video" ADD COLUMN "options" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "Video" ADD COLUMN "stages" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Clip" ADD COLUMN "rank" INTEGER;
ALTER TABLE "Clip" ADD COLUMN "error" TEXT;
ALTER TABLE "Clip" ADD COLUMN "renderProgress" REAL;
ALTER TABLE "Clip" ADD COLUMN "aspect" TEXT NOT NULL DEFAULT '9:16';
