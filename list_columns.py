import sqlite3
import os

db_path = "backend/app.db"

def list_columns():
    if not os.path.exists(db_path):
        print(f"Database not found at {db_path}")
        return

    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        print(f"Checking database: {db_path}")
        
        cursor.execute("PRAGMA table_info(projects)")
        columns = cursor.fetchall()
        for col in columns:
            print(col)

    except Exception as e:
        print(f"Error: {e}")
    finally:
        if conn:
            conn.close()

if __name__ == "__main__":
    list_columns()
