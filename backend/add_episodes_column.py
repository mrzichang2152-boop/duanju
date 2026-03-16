
import sqlite3
import os

def add_episodes_column():
    # Try multiple possible paths
    possible_paths = [
        "backend/app.db",
        "app.db",
        "../backend/app.db"
    ]
    
    db_path = None
    for path in possible_paths:
        if os.path.exists(path):
            db_path = path
            break
            
    if not db_path:
        print("Database not found.")
        return

    print(f"Connecting to database at {db_path}")
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    try:
        # Check if column exists
        cursor.execute("PRAGMA table_info(scripts)")
        columns = [info[1] for info in cursor.fetchall()]
        
        if "episodes" in columns:
            print("Column 'episodes' already exists in 'scripts' table.")
        else:
            print("Adding 'episodes' column to 'scripts' table...")
            cursor.execute("ALTER TABLE scripts ADD COLUMN episodes TEXT")
            conn.commit()
            print("Column added successfully.")
            
    except Exception as e:
        print(f"Error: {e}")
        conn.rollback()
    finally:
        conn.close()

if __name__ == "__main__":
    add_episodes_column()
