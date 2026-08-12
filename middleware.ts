import { next } from "@vercel/functions";

export default function middleware(request: Request) {
  const auth = request.headers.get("authorization");

  if (auth?.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice(6));
      const separator = decoded.indexOf(":");

      const username = decoded.slice(0, separator);
      const password = decoded.slice(separator + 1);

      if (
        username === process.env.BASIC_AUTH_USER &&
        password === process.env.BASIC_AUTH_PASSWORD
      ) {
        return next();
      }
    } catch {
      // Bad auth header
    }
  }

  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Private Site"',
      "Cache-Control": "no-store",
    },
  });
}

export const config = {
  matcher: "/(.*)",
};