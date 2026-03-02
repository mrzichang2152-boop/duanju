import sqlite3
import os

db_path = "backend/app.db"

def add_column():
    if not os.path.exists(db_path):
        print(f"Database not found at {db_path}")
        return

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    try:
        # Check if column exists
        cursor.execute("PRAGMA table_info(scripts)")
        columns = [info[1] for info in cursor.fetchall()]
        
        if "thinking" in columns:
            print("Column 'thinking' already exists in 'scripts' table.")
        else:
            print("Adding 'thinking' column to 'scripts' table...")
            cursor.execute("ALTER TABLE scripts ADD COLUMN thinking TEXT")
            conn.commit()
            print("Column added successfully.")
            
    except Exception as e:
        print(f"An error occurred: {e}")
    finally:
        conn.close()

if __name__ == "__main__":
    add_column()
