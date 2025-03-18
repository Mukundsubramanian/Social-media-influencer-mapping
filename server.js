// Updated server.js with dynamic column detection

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;


// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database connection
const pool = new Pool({
  user: process.env.DB_USER || 'mukundsubramanian',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'influencer_mapping',
  password: process.env.DB_PASSWORD || '505051',
  port: process.env.DB_PORT || 5432,
});

// Global variables to store table and column information
let tableInfo = {};

// Initialize database schema information
async function initDatabaseInfo() {
  try {
    // Get all tables
    const tablesResult = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    `);
    
    // For each table, get column information
    for (const table of tablesResult.rows) {
      const tableName = table.table_name;
      
      // Skip PostgreSQL internal tables
      if (tableName.startsWith('pg_') || tableName === 'information_schema') {
        continue;
      }
      
      const columnsResult = await pool.query(`
        SELECT column_name, data_type, column_default
        FROM information_schema.columns
        WHERE table_name = $1
        ORDER BY ordinal_position
      `, [tableName]);
      
      // Store column information
      tableInfo[tableName] = {
        columns: columnsResult.rows.map(col => ({
          name: col.column_name,
          type: col.data_type,
          isPrimary: col.column_default && col.column_default.includes('nextval')
        }))
      };
      
      // Try to identify primary key, name columns, etc.
      const idColumn = columnsResult.rows.find(col => 
        col.column_default && col.column_default.includes('nextval')
      );
      
      const nameColumn = columnsResult.rows.find(col => 
        col.column_name.includes('name') && col.data_type.includes('char')
      );
      
      if (idColumn) {
        tableInfo[tableName].idColumn = idColumn.column_name;
      }
      
      if (nameColumn) {
        tableInfo[tableName].nameColumn = nameColumn.column_name;
      }
    }
    
    console.log('Database schema information loaded');
  } catch (err) {
    console.error('Error loading database schema:', err);
  }
}

// Test database connection and initialize schema info
pool.query('SELECT NOW()', async (err, res) => {
  if (err) {
    console.error('Database connection error:', err.stack);
  } else {
    console.log('Database connected successfully');
    await initDatabaseInfo();
  }
});

// API route to get all tables
app.get('/api/tables', async (req, res) => {
  try {
    res.json(Object.keys(tableInfo));
  } catch (err) {
    console.error('Error fetching tables', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// API route to get columns for a specific table
app.get('/api/tables/:table/columns', async (req, res) => {
  try {
    const { table } = req.params;
    if (!tableInfo[table]) {
      return res.status(404).json({ error: 'Table not found' });
    }
    
    res.json(tableInfo[table].columns);
  } catch (err) {
    console.error('Error fetching columns', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// API route for data queries
app.post('/api/query', async (req, res) => {
  try {
    const { category, prompt } = req.body;
    
    // Check if table exists
    if (!tableInfo[category]) {
      return res.status(400).json({ error: `Table '${category}' not found` });
    }
    
    const table = category;
    const info = tableInfo[table];
    const idColumn = info.idColumn || 'id';
    const nameColumn = info.nameColumn || 'name';
    
    // Get column names for the table
    const columnNames = info.columns.map(col => col.name);
    
    // Basic query builder based on the prompt
    let query;
    let params = [];
    let queryIndex = 1;
    
    // Process the prompt
    const promptLower = prompt.toLowerCase();
    
    // Default to fetch all data with limit
    query = `SELECT * FROM ${table} LIMIT 20`;
    
    // Search by name if mentioned
    if ((promptLower.includes('name') || promptLower.includes('with name')) && columnNames.includes(nameColumn)) {
      // Extract the name from the prompt
      let nameParam = '%';
      
      if (promptLower.includes('with name')) {
        nameParam += prompt.split('with name')[1].trim().split(' ')[0] + '%';
      } else if (promptLower.includes('name')) {
        nameParam += prompt.split('name')[1].trim().split(' ')[0] + '%';
      }
      
      query = `SELECT * FROM ${table} WHERE ${nameColumn} ILIKE $${queryIndex} LIMIT 20`;
      params.push(nameParam);
    }
    // Sort by followers or budget if "top" is mentioned
    else if (promptLower.includes('top')) {
      if (columnNames.includes('follower_count')) {
        query = `SELECT * FROM ${table} ORDER BY follower_count DESC LIMIT 10`;
      } else if (columnNames.includes('campaign_budget')) {
        query = `SELECT * FROM ${table} ORDER BY campaign_budget DESC LIMIT 10`;
      } else if (columnNames.includes('budget')) {
        query = `SELECT * FROM ${table} ORDER BY budget DESC LIMIT 10`;
      }
    }
    // Filter by platform if mentioned (for profiles table)
    else if (promptLower.includes('platform') && columnNames.includes('platform')) {
      const platform = promptLower.split('platform')[1].trim().split(' ')[0];
      query = `SELECT * FROM ${table} WHERE platform ILIKE $${queryIndex} LIMIT 20`;
      params.push(`%${platform}%`);
    }
    // Filter by industry if mentioned (for brands table)
    else if (promptLower.includes('industry') && columnNames.includes('industry')) {
      const industry = promptLower.split('industry')[1].trim().split(' ')[0];
      query = `SELECT * FROM ${table} WHERE industry ILIKE $${queryIndex} LIMIT 20`;
      params.push(`%${industry}%`);
    }
    // Filter by age if mentioned (for demographics table)
    else if (promptLower.includes('age') && columnNames.includes('age_range')) {
      const age = promptLower.split('age')[1].trim().split(' ')[0];
      query = `SELECT * FROM ${table} WHERE age_range ILIKE $${queryIndex} LIMIT 20`;
      params.push(`%${age}%`);
    }
    // Filter by location if mentioned (for demographics table)
    else if (promptLower.includes('location') && columnNames.includes('location')) {
      const location = promptLower.split('location')[1].trim().split(' ')[0];
      query = `SELECT * FROM ${table} WHERE location ILIKE $${queryIndex} LIMIT 20`;
      params.push(`%${location}%`);
    }
    // Filter by status if mentioned (for campaigns table)
    else if (promptLower.includes('status') && columnNames.includes('status')) {
      const status = promptLower.split('status')[1].trim().split(' ')[0];
      query = `SELECT * FROM ${table} WHERE status ILIKE $${queryIndex} LIMIT 20`;
      params.push(`%${status}%`);
    }
    
    console.log('Executing query:', query, params);
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error executing query', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});

// Fallback route for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
