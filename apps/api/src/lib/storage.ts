import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const extensionByMimeType: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp"
};

export class LocalPhotoStorage {
  private readonly rootDir = path.resolve(process.env.UPLOAD_DIR ?? "./uploads");

  async saveCheckInPhoto(
    taskId: string,
    userId: string,
    file: Pick<Express.Multer.File, "buffer" | "mimetype">
  ): Promise<string> {
    const extension = extensionByMimeType[file.mimetype];
    if (!extension) {
      throw Object.assign(new Error("照片格式仅支持 JPEG、PNG 或 WebP"), { statusCode: 400 });
    }

    const directory = path.join(this.rootDir, "check-ins", taskId, userId);
    await mkdir(directory, { recursive: true });

    const filename = `${Date.now()}-${randomUUID()}${extension}`;
    const destination = path.join(directory, filename);
    const temporaryFile = `${destination}.tmp`;
    await writeFile(temporaryFile, file.buffer);
    await rename(temporaryFile, destination);

    return `/uploads/check-ins/${taskId}/${userId}/${filename}`;
  }

  async removeByPublicUrl(publicUrl: string): Promise<void> {
    if (!publicUrl.startsWith("/uploads/")) return;
    const relativePath = publicUrl.slice("/uploads/".length);
    const target = path.resolve(this.rootDir, relativePath);
    if (!target.startsWith(`${this.rootDir}${path.sep}`)) return;
    await rm(target, { force: true });
  }

  resolvePublicUrl(publicUrl: string): string {
    if (!publicUrl.startsWith("/uploads/")) {
      throw new Error("不支持的照片存储地址");
    }
    const relativePath = publicUrl.slice("/uploads/".length);
    const target = path.resolve(this.rootDir, relativePath);
    if (!target.startsWith(`${this.rootDir}${path.sep}`)) {
      throw new Error("非法照片存储地址");
    }
    return target;
  }
}

export const photoStorage = new LocalPhotoStorage();
