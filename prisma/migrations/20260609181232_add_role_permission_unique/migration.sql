-- AlterTable: add unique constraint to prevent duplicate role-permission assignments
CREATE UNIQUE INDEX "role_permissions_roleId_permissionId_key" ON "role_permissions"("roleId", "permissionId");
