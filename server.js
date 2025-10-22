const express = require('express');
const pg = require('pg');
const { SocksClient } = require('socks');

const requiredEnvVars = [
    'DB_HOST',
    'DB_PORT',
    'PGDATABASE',
    'PGPASSWORD',
    'PGUSER',
    'FIXIE_SOCKS_HOST'
];

const missingVars = requiredEnvVars.filter(v => !process.env[v]);

if (missingVars.length > 0) {
    console.error(`FATAL: The following required environment variables are missing: ${missingVars.join(', ')}`);
}

// Print environment variables if ENV=dev
if (process.env.ENV === 'dev') {
    console.log('\n--- Environment Variables (ENV=dev) ---');
    requiredEnvVars.forEach(v => {
        const value = process.env[v] || '(Not Set - Using Placeholder)';
        console.log(`${v}: ${value}`);
    });
    console.log('-------------------------------------\n');
}

const pgServer = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432
};

const fixieUrl = process.env.FIXIE_SOCKS_HOST // format: fixieuser:fixiepass@socks.fixie.io:1080

// Safely parse the SOCKS URL (user:pass@host:port)
const fixieParts = fixieUrl.split(/[:@]/).filter(v => v.length > 0);

// Extract credentials and host/port for the SOCKS proxy itself
const [fixieUser, fixiePass, fixieHost, fixiePort] = fixieParts;

/**
 * Creates and connects a new PostgreSQL client instance routed through the SOCKS proxy.
 * This function uses the 'socks' library to establish a tunneled net.Socket.
 * @returns {Promise<pg.Client>} A promise that resolves to a connected pg.Client.
 */
function getProxiedPgClient() {
    return new Promise(async (resolve, reject) => {
        let stream;
        try {
            // Configuration for the SOCKS proxy connection command
            const proxyOptions = {
                proxy: {
                    ipaddress: fixieHost,
                    // Ensure the proxy port is an integer
                    port: parseInt(fixiePort, 10),
                    type: 5, // Assuming SOCKS5
                    userId: fixieUser,
                    password: fixiePass
                },
                command: 'connect',
                destination: {
                    host: pgServer.host,
                    port: pgServer.port
                }
            };

            const { socket } = await SocksClient.createConnection(proxyOptions);

            // The `pg` driver will attempt to call `connect()` on this socket despite
            // us already having a connection established. We use a Proxy to stub out
            // the methods that would otherwise fail on macOS due to the double-connect attempt.
            stream = new Proxy(socket, {
                get(target, prop) {
                    // Replace `connect` method with a no-op to avoid EISCONN from MacOS
                    if (prop === "connect" && typeof target[prop] === "function") {
                        return () => target;
                    }

                    // Monkey-patch `once()` event listener method to immediately resolve
                    // any listeners registered for the "connect" event (which has already fired).
                    if (prop === "once" && typeof target[prop] === "function") {
                        return (event, listener) => {
                            if (event === "connect") {
                                setImmediate(listener);
                                return target;
                            }

                            return target.once(event, listener);
                        };
                    }

                    return Reflect.get(target, prop);
                },
            });

        } catch (err) {
            // If SOCKS connection fails (e.g., bad proxy credentials, proxy down)
            return reject(new Error(`SOCKS proxy connection failed: ${err.message}`));
        }

        const connectionConfig = {
            stream: stream, // The established net.Socket through SOCKS
            // Disabled strict SSL certificate checking to resolve SELF_SIGNED_CERT_IN_CHAIN error.
            ssl: { 
                rejectUnauthorized: false 
            }
        };

        const client = new pg.Client(connectionConfig);

        client.connect(err => {
            if (err) {
                console.error('Error connecting to PG via SOCKS proxy:', err.message);
                // Ensure the stream is destroyed if PG connection fails
                stream.destroy();
                return reject(err);
            }
            resolve(client);
        });
    });
}

// --- Express Server Setup ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('PG Proxy Test Server is running. Go to /query to test the database connection.');
});

// GET /query endpoint to execute a database query
app.get('/query', async (req, res) => {
    let client;
    try {
        // 1. Establish the proxied connection
        client = await getProxiedPgClient();

        // 2. Execute the query
        // The query is simple to confirm connectivity
        const result = await client.query('SELECT NOW() AS current_time, inet_client_addr() AS client_ip');

        // 3. Send the result
        console.log('Query successful:', result.rows[0]);
        res.json({
            status: 'success',
            message: 'Database query executed successfully via SOCKS proxy.',
            data: result.rows
        });

    } catch (error) {
        console.error('Error during database operation:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to execute database query.',
            details: error.message
        });
    } finally {
        // 4. IMPORTANT: Always end the client connection
        if (client) {
            try {
                // The client.end() method will also destroy the underlying stream
                await client.end();
                console.log('Client connection closed.');
            } catch (endErr) {
                console.error('Error closing client connection:', endErr.message);
            }
        }
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Express server listening on port ${PORT}`);
    console.log(`Test endpoint: http://localhost:${PORT}/query`);
});
