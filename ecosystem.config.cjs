module.exports = {
  apps: [
    {
      name: 'treatment-app',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
      out_file:   './logs/out.log',
      error_file: './logs/err.log',
      time: true,
    },
  ],
};
