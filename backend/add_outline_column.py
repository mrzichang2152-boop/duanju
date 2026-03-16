
import sqlite3
import os

DB_PATH = "backend/app.db"

def add_outline_column():
    if not os.path.exists(DB_PATH):
        print(f"Database not found at {DB_PATH}")
        return

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    try:
        # Check if column exists
        cursor.execute("PRAGMA table_info(scripts)")
        columns = [info[1] for info in cursor.fetchall()]
        
        if "outline" in columns:
            print("Column 'outline' already exists in 'scripts' table.")
        else:
            print("Adding 'outline' column to 'scripts' table...")
            cursor.execute("ALTER TABLE scripts ADD COLUMN outline TEXT")
            conn.commit()
            print("Column added successfully.")
            
    except Exception as e:
        print(f"Error: {e}")
        conn.rollback()
    finally:
        conn.close()

if __name__ == "__main__":
    add_outline_column()
