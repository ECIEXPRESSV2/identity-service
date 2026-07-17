-- CreateEnum
CREATE TYPE "PqrsStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "PqrsSenderRole" AS ENUM ('USER', 'ADMIN');

-- CreateTable
CREATE TABLE "pqrs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "PqrsStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,

    CONSTRAINT "pqrs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pqrs_messages" (
    "id" TEXT NOT NULL,
    "pqrsId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "senderRole" "PqrsSenderRole" NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pqrs_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pqrs_userId_idx" ON "pqrs"("userId");

-- CreateIndex
CREATE INDEX "pqrs_messages_pqrsId_idx" ON "pqrs_messages"("pqrsId");

-- AddForeignKey
ALTER TABLE "pqrs" ADD CONSTRAINT "pqrs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pqrs_messages" ADD CONSTRAINT "pqrs_messages_pqrsId_fkey" FOREIGN KEY ("pqrsId") REFERENCES "pqrs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
