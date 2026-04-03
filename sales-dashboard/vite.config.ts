import { Pool } from 'pg'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const recorderTypeHex = '000003f1'

function excludedRecorderPrefixesPlugin(): Plugin {
  const pool = new Pool({
    host: '217.175.41.212',
    port: 5444,
    user: 'ecostock',
    password: 'Kd*2m5Th',
    database: 'onec_ecostock_retail',
    max: 2,
    idleTimeoutMillis: 5_000,
  })

  return {
    name: 'excluded-recorder-prefixes',
    configureServer(server) {
      server.middlewares.use('/api/excluded-recorder-prefixes', async (_req, res) => {
        try {
          const { rows } = await pool.query<{ prefix: string }>(
            `
              select distinct encode(_recorderrref, 'hex') as prefix
              from _accumrg53715
              where _recordertref = decode($1, 'hex')
              order by 1
            `,
            [recorderTypeHex]
          )

          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ prefixes: rows.map((row) => row.prefix) }))
        } catch (error) {
          console.error('Failed to load excluded recorder prefixes', error)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ prefixes: [], error: 'failed_to_load_exclusions' }))
        }
      })
    },
    async closeBundle() {
      await pool.end()
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), excludedRecorderPrefixesPlugin()],
})
