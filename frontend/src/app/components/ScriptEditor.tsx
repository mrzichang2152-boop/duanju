import React, { useState, useEffect, useRef, useCallback } from 'react';

interface ScriptEditorProps {
  content: string;
  onChange: (newContent: string) => void;
}

type Block = 
  | { type: 'text'; value: string }
  | { type: 'table'; headers: string[]; rows: string[][] };

export function ScriptEditor({ content, onChange }: ScriptEditorProps) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  // Initialize with specific value to ensure first sync happens if content is present
  const lastSerializedRef = useRef<string>('__INITIAL_EMPTY__'); 
  const isInternalUpdate = useRef(false);

  // Parse markdown content into blocks
  const parseMarkdown = useCallback((markdown: string): Block[] => {
    const lines = markdown.split('\n');
    const newBlocks: Block[] = [];
    let currentTextLines: string[] = [];
    let currentTableLines: string[] = [];
    let inTable = false;

    // Helper to check if a line looks like a table separator
    const isSeparatorLine = (line: string) => {
      const trimmed = line.trim();
      // Must contain only separator characters: | - : and whitespace
      // And must have at least one dash
      // And must have a pipe
      return /^[\s\|\-:]+$/.test(trimmed) && trimmed.includes('-') && trimmed.includes('|');
    };

    // Helper to check if a line looks like a table row
    const isTableLine = (line: string) => {
      const trimmed = line.trim();
      // Must contain a pipe, or start with pipe
      return trimmed.startsWith('|') || trimmed.startsWith('｜') || trimmed.includes('|');
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();
      
      // Check for table start
      if (!inTable) {
        const nextLine = lines[i + 1];
        if (isTableLine(line) && nextLine && isSeparatorLine(nextLine)) {
           // Flush text
           if (currentTextLines.length > 0) {
             newBlocks.push({ type: 'text', value: currentTextLines.join('\n') });
             currentTextLines = [];
           }
           inTable = true;
           currentTableLines.push(line);
        } else {
           currentTextLines.push(line);
        }
      } else {
        // Inside table
        if (isTableLine(line)) {
          currentTableLines.push(line);
        } else {
          // Table ended by non-table line
          inTable = false;
          if (currentTableLines.length > 0) {
            newBlocks.push(parseTableBlock(currentTableLines));
            currentTableLines = [];
          }
          currentTextLines.push(line);
        }
      }
    }

    // Flush remaining buffers
    if (inTable && currentTableLines.length > 0) {
      newBlocks.push(parseTableBlock(currentTableLines));
    }
    if (currentTextLines.length > 0) {
      newBlocks.push({ type: 'text', value: currentTextLines.join('\n') });
    }

    return newBlocks;
  }, []);

  const parseTableBlock = (lines: string[]): Block => {
    // lines[0]: header, lines[1]: separator, lines[2+]: rows
    const headerLine = lines[0];
    const rowLines = lines.slice(2);

    const cleanSplit = (line: string) => {
      // Split by pipe but handle escaped pipes
      const placeholder = "___PIPE___";
      const protectedLine = line.replace(/\\\|/g, placeholder);
      const parts = protectedLine.split('|').map(p => p.replace(new RegExp(placeholder, 'g'), '|'));
      
      // Markdown tables have empty first/last elements if lines start/end with |
      if (parts.length > 0 && parts[0].trim() === '') parts.shift();
      if (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop();
      return parts; 
    };

    const headers = cleanSplit(headerLine).map(h => h.trim());
    const rows = rowLines.map(line => cleanSplit(line).map(c => c.trim().replace(/<br\s*\/?>/gi, '\n')));

    return { type: 'table', headers, rows };
  };

  const getColumnWidthClass = (header: string) => {
    const text = header.replace(/\s+/g, '');
    if (text.includes('集数') || text.includes('时长')) return 'w-[80px] min-w-[80px]';
    if (text.includes('场景') || text.includes('人物') || text.includes('角色')) return 'w-[150px] min-w-[150px]';
    if (text.includes('剧情') || text.includes('内容') || text.includes('台词') || text.includes('画面')) return 'min-w-[400px]';
    if (text.includes('爽点') || text.includes('反转') || text.includes('钩子') || text.includes('备注')) return 'w-[180px] min-w-[180px]';
    return 'min-w-[120px]';
  };

  const serializeBlocks = useCallback((currentBlocks: Block[]): string => {
    return currentBlocks.map(block => {
      if (block.type === 'text') {
        return block.value;
      } else {
        // Convert table back to markdown
        // Ensure all rows have same number of columns
        const headers = block.headers;
        const rows = block.rows;
        
        // Calculate max width for alignment (optional, but good for readability)
        // For now just simple joining
        const headerLine = `| ${headers.join(' | ')} |`;
        const separatorLine = `| ${headers.map(() => '---').join(' | ')} |`;
        const rowLines = rows.map(row => `| ${row.map(c => c.replace(/\n/g, '<br>')).join(' | ')} |`);
        
        return [headerLine, separatorLine, ...rowLines].join('\n');
      }
    }).join('\n');
  }, []);

  // Handle external content updates
  useEffect(() => {
    // If it's an internal update, we ignore it as we already have the latest blocks
    if (isInternalUpdate.current) {
        return;
    }

    // Sync if content changed externally
    if (content !== lastSerializedRef.current) {
      setBlocks(parseMarkdown(content));
      lastSerializedRef.current = content;
    }
  }, [content, parseMarkdown]);

  // Update content when blocks change (internal change)
  useEffect(() => {
    if (isInternalUpdate.current) {
      const newContent = serializeBlocks(blocks);
      if (newContent !== content) {
        lastSerializedRef.current = newContent;
        onChange(newContent);
      }
      isInternalUpdate.current = false;
    }
  }, [blocks, serializeBlocks, onChange, content]);

  const updateBlock = (index: number, value: string) => {
    isInternalUpdate.current = true;
    setBlocks(prev => prev.map((b, i) => i === index && b.type === 'text' ? { ...b, value } : b));
  };

  const updateTable = (blockIndex: number, rowIndex: number, colIndex: number, value: string) => {
    isInternalUpdate.current = true;
    setBlocks(prev => prev.map((b, i) => {
      if (i === blockIndex && b.type === 'table') {
        const newRows = [...b.rows];
        newRows[rowIndex] = [...newRows[rowIndex]];
        newRows[rowIndex][colIndex] = value;
        return { ...b, rows: newRows };
      }
      return b;
    }));
  };

  return (
    <div className="w-full bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
      {blocks.map((block, index) => {
        if (block.type === 'text') {
          return (
            <TextBlock 
              key={index} 
              value={block.value} 
              onChange={(v) => updateBlock(index, v)} 
            />
          );
        } else {
          return (
            <div key={index} className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-100">
                  <tr>
                    {block.headers.map((header, i) => (
                      <th 
                        key={i} 
                        className={`px-4 py-3 font-medium whitespace-nowrap ${getColumnWidthClass(header)}`}
                      >
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="hover:bg-slate-50 group">
                      {row.map((cell, colIndex) => (
                        <td 
                          key={colIndex} 
                          className={`px-4 py-3 min-w-[150px] relative align-top ${getColumnWidthClass(block.headers[colIndex] || '')}`}
                        >
                          <AutoResizeTextarea
                            value={cell}
                            onChange={(v) => updateTable(index, rowIndex, colIndex, v)}
                            className="w-full bg-transparent border-none focus:ring-0 p-0 text-slate-700 resize-none overflow-hidden min-h-[24px] leading-relaxed"
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
      })}
    </div>
  );
}

function AutoResizeTextarea({ value, onChange, className }: { value: string, onChange: (v: string) => void, className?: string }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  // Adjust on mount and window resize
  useEffect(() => {
    adjustHeight();
    window.addEventListener('resize', adjustHeight);
    return () => window.removeEventListener('resize', adjustHeight);
  }, [adjustHeight]);

  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className}
      rows={1}
    />
  );
}

function TextBlock({ value, onChange }: { value: string, onChange: (v: string) => void }) {
  const [isEditing, setIsEditing] = useState(false);

  if (isEditing) {
    return (
      <div className="p-4 border-b border-slate-100 last:border-0 relative group">
        <textarea
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setIsEditing(false)}
          className="w-full min-h-[100px] resize-y outline-none text-slate-700 leading-relaxed font-mono text-sm bg-slate-50 p-2 rounded"
          placeholder="输入剧本内容..."
        />
      </div>
    );
  }

  return (
    <div 
      onClick={() => setIsEditing(true)}
      className="p-4 border-b border-slate-100 last:border-0 cursor-text min-h-[50px] hover:bg-slate-50 transition-colors"
    >
      {value.split('\n').map((line, i) => {
         const trimmed = line.trim();
         // Headers
         if (trimmed.startsWith('# ')) return <h1 key={i} className="text-2xl font-bold mb-4 text-slate-900">{trimmed.substring(2)}</h1>;
         if (trimmed.startsWith('## ')) return <h2 key={i} className="text-xl font-bold mb-3 text-slate-800">{trimmed.substring(3)}</h2>;
         if (trimmed.startsWith('### ')) return <h3 key={i} className="text-lg font-bold mb-2 text-slate-800">{trimmed.substring(4)}</h3>;
         
         // List items
         if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
           return (
             <div key={i} className="flex items-start mb-1 ml-4">
               <span className="mr-2">•</span>
               <span>{renderInlineMarkdown(trimmed.substring(2))}</span>
             </div>
           );
         }

         // Empty lines
         if (!trimmed) return <div key={i} className="h-4"></div>;

         // Regular paragraph
         return (
           <div key={i} className="mb-2 text-slate-700 leading-relaxed">
             {renderInlineMarkdown(line)}
           </div>
         );
      })}
    </div>
  );
}

function renderInlineMarkdown(text: string) {
  // Simple bold parsing: **text**
  const parts = text.split(/(\*\*.*?\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index} className="font-bold text-slate-900">{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}
