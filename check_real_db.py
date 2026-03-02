import sqlite3
import sys
import os

# Update path to the real database used in docker-compose
db_path = "data/db.sqlite3"
project_id = "1a266750-2465-41cb-961d-17130353356d"

def check_script():
    if not os.path.exists(db_path):
        print(f"Database not found at {db_path}")
        return

    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        print(f"Checking script for project: {project_id} in {db_path}")
        
        # Check active script - WITHOUT thinking column first to confirm data exists
        try:
            cursor.execute("SELECT id, version, length(content) FROM scripts WHERE project_id = ? AND is_active = 1", (project_id,))
            row = cursor.fetchone()
            
            if row:
                print(f"Active Script Found (Legacy Check):")
                print(f"ID: {row[0]}")
                print(f"Version: {row[1]}")
                print(f"Content Length: {row[2]}")
            else:
                print("No active script found.")
        except sqlite3.OperationalError as e:
            print(f"Query Error: {e}")

        # Check if 'thinking' column exists
        cursor.execute("PRAGMA table_info(scripts)")
        columns = [info[1] for info in cursor.fetchall()]
        if "thinking" in columns:
            print("'thinking' column EXISTS.")
        else:
            print("'thinking' column MISSING.")
            
    except Exception as e:
        print(f"Error: {e}")
    finally:
        if conn:
            conn.close()

if __name__ == "__main__":
    check_script()
