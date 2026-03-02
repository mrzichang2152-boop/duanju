import sqlite3
import os

# In the container, the database is mounted at /app/data/db.sqlite3
# In local development (if running from root), it might be backend/app.db or data/db.sqlite3
# We will try multiple paths.

POSSIBLE_PATHS = [
    "/app/data/db.sqlite3",  # Docker container production path
    "data/db.sqlite3",       # Local or Host path relative to root
    "backend/app.db",        # Local development default
]

def get_db_path():
    for path in POSSIBLE_PATHS:
        if os.path.exists(path):
            return path
    return None

def add_column():
    db_path = get_db_path()
    if not db_path:
        print(f"Database not found. Checked: {POSSIBLE_PATHS}")
        return

    print(f"Using database at: {db_path}")
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
