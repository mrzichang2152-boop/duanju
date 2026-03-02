import sqlite3
import sys

db_path = "backend/app.db"
project_id = "1a266750-2465-41cb-961d-17130353356d"

def check_script():
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        print(f"Checking script for project: {project_id}")
        
        # Check active script
        cursor.execute("SELECT id, version, length(content), content, thinking FROM scripts WHERE project_id = ? AND is_active = 1", (project_id,))
        row = cursor.fetchone()
        
        if row:
            print(f"Active Script Found:")
            print(f"ID: {row[0]}")
            print(f"Version: {row[1]}")
            print(f"Content Length: {row[2]}")
            print(f"Content Preview: {row[3][:100] if row[3] else 'EMPTY'}")
            print(f"Thinking Preview: {row[4][:100] if row[4] else 'EMPTY/NULL'}")
        else:
            print("No active script found.")
            
        # Check history
        print("\nHistory:")
        cursor.execute("SELECT id, version, length(content), created_at FROM scripts WHERE project_id = ? ORDER BY version DESC LIMIT 5", (project_id,))
        rows = cursor.fetchall()
        for r in rows:
            print(f"Ver {r[1]}: Len={r[2]}, Date={r[3]}")
            
    except Exception as e:
        print(f"Error: {e}")
    finally:
        if conn:
            conn.close()

if __name__ == "__main__":
    check_script()
