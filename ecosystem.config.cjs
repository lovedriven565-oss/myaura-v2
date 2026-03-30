module.exports = {
  apps: [
    {
      name: "myaura-app",
      script: "dist/server.js",
      instances: "max", // Or a specific number like 2
      exec_mode: "cluster",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: "production",
        PORT: 3000,
      }
    }
  ]
};
