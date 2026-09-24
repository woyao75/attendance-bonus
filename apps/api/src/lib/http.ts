import type { Request, Response, NextFunction } from "express";
export const fail = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });
export function route(
  handler: (req: Request, res: Response) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch(next);
  };
}
