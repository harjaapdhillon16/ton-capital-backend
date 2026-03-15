import 'express';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: {
      userId: string | null;
      telegramId: string;
      username: string | null;
      firstName: string | null;
      lastName: string | null;
    };
  }
}
