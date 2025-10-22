const express = require('express');
const pg = require('pg');
const SocksConnection = require('socksjs');

// --- Configuration and Fixie/PG Setup ---

// Ensure the FIXIE_SOCKS_HOST is set in your environment
const fixieUrl = process.env.FIXIE_SOCKS_HOST;

if (!fixieUrl) {
    console.error("FATAL: FIXIE_SOCKS_HOST environment variable not set.");
    process.exit(1);
}

// Split the Fixie URL (assumes format: socks://user:pass@host:port)
// The regex extracts the parts we need: [user, pass, host, port]
const fixieValues = fixieUrl.split(new RegExp('[/(:\\/@)/]+')).filter(Boolean);

if (fixieValues.length !== 4) {
    console.error("FATAL: FIXIE_SOCKS_HOST format is incorrect. Expected: socks://user:pass@host:port");
    process.exit(1);
}

// Target PostgreSQL server details
const pgServer = {
  host: process.env.DB_HOST,        // <-- REPLACE with your DB host
  port: process.env.DB_PORT
};

// Create the SOCKS connection stream using Fixie details
const fixieConnection = new SocksConnection(pgServer, {
  user: fixieValues[0], // Fixie username
  pass: fixieValues[1], // Fixie password
  host: fixieValues[2], // Fixie host
  port: fixieValues[3], // Fixie port
});

// PostgreSQL connection configuration
const connectionConfig = {
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  stream: fixieConnection.socket,
  ssl: {
      rejectUnauthorized: false // Often required for remote SSL
  }
};

// --- Express Server Setup ---

const app = express();
const PORT = process.env.PORT || 3000;

// --- /query Endpoint ---

app.get('/query', (req, res) => {
    // 1. Create a new client for this request
    const client = new pg.Client(connectionConfig);

    // 2. Connect to the database
    client.connect(function (err) {
        if (err) {
            console.error('Database connection error:', err);
            // Send a 500 status back to the client
            return res.status(500).json({ error: 'Database connection failed', details: err.message });
        }

        // 3. Execute the hardcoded query: 'SELECT 1+1 as test1'
        client.query('SELECT inet_client_addr();', function (err, result) {
            // 4. Close the connection
            client.end(function (endErr) {
                if (endErr) console.error('Error closing database connection:', endErr);
            });

            // 5. Handle query results
            if (err) {
                console.error('Database query error:', err);
                return res.status(500).json({ error: 'Database query failed', details: err.message });
            }

            // Success: Send back the result row
            // The result is structured as: { test1: 2 }
            res.json(result.rows[0]);
        });
    });
});

// --- Start Server ---
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Access the endpoint via: http://localhost:${PORT}/query`);
});