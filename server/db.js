import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '../whatoo_db.json');

// S'assurer que le fichier existe avec une structure par défaut
if (!fs.existsSync(dbPath)) {
  fs.writeFileSync(dbPath, JSON.stringify({ automations: [], responses: [] }, null, 2));
}

const readData = () => {
  try {
    const data = fs.readFileSync(dbPath, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return { automations: [], responses: [] };
  }
};

const writeData = (data) => {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
};

class SQLStatement {
  constructor(sql) {
    this.sql = sql.trim().replace(/\s+/g, ' ');
  }

  all(...args) {
    const data = readData();

    // 1. Get all automations
    if (this.sql.startsWith('SELECT * FROM automations')) {
      return [...data.automations].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }

    // 2. Get responses for automation
    if (this.sql.includes('SELECT * FROM responses WHERE automation_id = ?')) {
      const autoId = args[0];
      return data.responses
        .filter(r => r.automation_id === parseInt(autoId))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }

    // 3. Get all active responses for active automations
    if (this.sql.includes('SELECT r.* FROM responses r JOIN automations a')) {
      const activeAutoIds = data.automations.filter(a => a.is_active === 1).map(a => a.id);
      return data.responses.filter(r => activeAutoIds.includes(r.automation_id));
    }

    return [];
  }

  get(...args) {
    const data = readData();

    // 1. Count responses for automation
    if (this.sql.includes('SELECT COUNT(*) as count FROM responses WHERE automation_id = ?')) {
      const autoId = args[0];
      const count = data.responses.filter(r => r.automation_id === parseInt(autoId)).length;
      return { count };
    }

    // 2. Get specific automation by ID
    if (this.sql.includes('SELECT * FROM automations WHERE id = ?')) {
      const autoId = parseInt(args[0]);
      return data.automations.find(a => a.id === autoId) || null;
    }

    // 3. Get specific response by ID
    if (this.sql.includes('SELECT * FROM responses WHERE id = ?')) {
      const respId = parseInt(args[0]);
      return data.responses.find(r => r.id === respId) || null;
    }

    return null;
  }

  run(...args) {
    const data = readData();

    // 1. Insert automation
    if (this.sql.includes('INSERT INTO automations')) {
      const name = args[0];
      const newId = data.automations.length > 0 ? Math.max(...data.automations.map(a => a.id)) + 1 : 1;
      const newAuto = {
        id: newId,
        name,
        is_active: 1,
        created_at: new Date().toISOString()
      };
      data.automations.push(newAuto);
      writeData(data);
      return { lastInsertRowid: newId };
    }

    // 2. Toggle active state
    if (this.sql.includes('UPDATE automations SET is_active = ? WHERE id = ?')) {
      const isActive = args[0];
      const id = parseInt(args[1]);
      const index = data.automations.findIndex(a => a.id === id);
      if (index !== -1) {
        data.automations[index].is_active = isActive;
        writeData(data);
      }
      return { changes: 1 };
    }

    // 3. Delete automation
    if (this.sql.includes('DELETE FROM automations WHERE id = ?')) {
      const id = parseInt(args[0]);
      data.automations = data.automations.filter(a => a.id !== id);
      // Supprimer les réponses associées (Cascade delete)
      data.responses = data.responses.filter(r => r.automation_id !== id);
      writeData(data);
      return { changes: 1 };
    }

    // 4. Insert response
    if (this.sql.includes('INSERT INTO responses')) {
      const [automation_id, keywords, response_type, content, buttons] = args;
      const newId = data.responses.length > 0 ? Math.max(...data.responses.map(r => r.id)) + 1 : 1;
      const newResponse = {
        id: newId,
        automation_id: parseInt(automation_id),
        keywords,
        response_type,
        content,
        buttons,
        created_at: new Date().toISOString()
      };
      data.responses.push(newResponse);
      writeData(data);
      return { lastInsertRowid: newId };
    }

    // 5. Delete individual response
    if (this.sql.includes('DELETE FROM responses WHERE id = ?')) {
      const id = parseInt(args[0]);
      data.responses = data.responses.filter(r => r.id !== id);
      writeData(data);
      return { changes: 1 };
    }

    // 6. Update response
    if (this.sql.includes('UPDATE responses SET keywords = ?')) {
      const [keywords, response_type, content, buttons, id] = args;
      const index = data.responses.findIndex(r => r.id === parseInt(id));
      if (index !== -1) {
        data.responses[index].keywords = keywords;
        data.responses[index].response_type = response_type;
        data.responses[index].content = content;
        data.responses[index].buttons = buttons;
        writeData(data);
      }
      return { changes: 1 };
    }

    return { changes: 0 };
  }
}

const db = {
  prepare(sql) {
    return new SQLStatement(sql);
  },
  exec(sql) {
    // Utile pour la compatibilité avec SQLite init
    return;
  },
  pragma(sql) {
    return;
  }
};

export default db;
