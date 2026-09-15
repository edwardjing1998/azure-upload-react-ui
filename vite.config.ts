import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const DEFAULT_AUTH_API_URL =
  "https://security-ui-chat8gpt20180625-dev.apps.rm1.0a51.p1.openshiftapps.com";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api/auth": {
        target: process.env.VITE_DEV_AUTH_API_URL || DEFAULT_AUTH_API_URL,
        changeOrigin: true,
      },
      "/api/users": {
        target: process.env.VITE_DEV_AUTH_API_URL || DEFAULT_AUTH_API_URL,
        changeOrigin: true,
      },
      "/api/upload-sessions": {
        target: process.env.VITE_DEV_API_URL || "http://localhost:4444",
        changeOrigin: true,
      },
    },
  },
});
