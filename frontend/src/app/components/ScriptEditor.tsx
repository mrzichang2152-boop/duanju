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
  const lastSerializedRef = useRef<string>(content);
  const isInternalUpdate = useRef(false);

  // Parse markdown content into blocks
  const parseMarkdown = useCallback((markdown: string): Block[] => {
    const lines = markdown.split('\n');
    const newBlocks: Block[] = [];
    let currentTextLines: string[] = [];
    let currentTableLines: string[] = [];
    let inTable = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();
      const isTableLine = trimmedLine.startsWith('|');

      if (isTableLine) {
        if (!inTable) {
          // Check if this is a table start (must have header and separator)
          const nextLine = lines[i + 1];
          // Check for separator line (e.g. |---| or |:---|)
          if (nextLine && nextLine.trim().startsWith('|') && nextLine.includes('---')) {
             inTable = true;
             // Flush accumulated text
             if (currentTextLines.length > 0) {
               newBlocks.push({ type: 'text', value: currentTextLines.join('\n') });
               currentTextLines = [];
             }
             currentTableLines.push(line);
          } else {
             // Not a table start, treat as text
             currentTextLines.push(line);
          }
        } else {
          // Inside table
          currentTableLines.push(line);
        }
      } else {
        if (inTable) {
          // Table ended
          inTable = false;
          if (currentTableLines.length > 0) {
            newBlocks.push(parseTableBlock(currentTableLines));
            currentTableLines = [];
          }
          currentTextLines.push(line);
        } else {
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
      // Split by pipe but handle escaped pipes if possible? 
      // For now simple split is enough for this use case
      const parts = line.split('|');
      // Markdown tables have empty first/last elements if lines start/end with |
      if (parts.length > 0 && parts[0].trim() === '') parts.shift();
      if (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop();
      return parts; 
    };

    const headers = cleanSplit(headerLine).map(h => h.trim());
    const rows = rowLines.map(line => cleanSplit(line).map(c => c.trim()));

    return { type: 'table', headers, rows };
  };

  const serializeBlocks = useCallback((currentBlocks: Block[]): string => {
    return currentBlocks.map(block => {
      if (block.type === 'text') {
        return block.value;
      } else {
        const { headers, rows } = block;
        // Pad to look nice? Or just minimal
        const headerLine = `| ${headers.join(' | ')} |`;
        const separatorLine = `| ${headers.map(() => '---').join(' | ')} |`;
        const rowLines = rows.map(row => `| ${row.join(' | ')} |`);
        return [headerLine, separatorLine, ...rowLines].join('\n');
      }
    }).join('\n');
  }, []);

  // Sync content prop to blocks, but avoid re-parsing if it's our own update
  useEffect(() => {
    // If the content is exactly what we just serialized, don't re-parse
    // This prevents cursor jumping and unnecessary re-renders during typing
    if (content === lastSerializedRef.current && isInternalUpdate.current) {
      isInternalUpdate.current = false;
      return;
    }
    
    // Also check if content is effectively the same to avoid parsing on every parent render
    if (content === lastSerializedRef.current) {
        return;
    }

    setBlocks(parseMarkdown(content));
    lastSerializedRef.current = content;
  }, [content, parseMarkdown]);

  const updateBlocks = (newBlocks: Block[]) => {
    setBlocks(newBlocks);
    const newContent = serializeBlocks(newBlocks);
    lastSerializedRef.current = newContent;
    isInternalUpdate.current = true;
    onChange(newContent);
  };

  const handleTextChange = (index: number, newValue: string) => {
    const newBlocks = [...blocks];
    if (newBlocks[index].type === 'text') {
      // @ts-ignore
      newBlocks[index] = { ...newBlocks[index], value: newValue };
      updateBlocks(newBlocks);
    }
  };

  const handleCellChange = (blockIndex: number, rowIndex: number, colIndex: number, newValue: string) => {
    const newBlocks = [...blocks];
    const block = newBlocks[blockIndex];
    if (block.type === 'table') {
      // Deep copy rows to avoid mutating state directly
      const newRows = [...block.rows];
      newRows[rowIndex] = [...newRows[rowIndex]];
      newRows[rowIndex][colIndex] = newValue;
      
      // @ts-ignore
      newBlocks[blockIndex] = { ...block, rows: newRows };
      updateBlocks(newBlocks);
    }
  };

  const handleHeaderChange = (blockIndex: number, colIndex: number, newValue: string) => {
    const newBlocks = [...blocks];
    const block = newBlocks[blockIndex];
    if (block.type === 'table') {
        const newHeaders = [...block.headers];
        newHeaders[colIndex] = newValue;
        // @ts-ignore
        newBlocks[blockIndex] = { ...block, headers: newHeaders };
        updateBlocks(newBlocks);
    }
  };

  return (
    <div className="w-full bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
      {blocks.map((block, index) => {
        if (block.type === 'text') {
          return (
            <div key={index} className="p-4 border-b border-slate-100 last:border-0">
              <textarea
                value={block.value}
                onChange={(e) => handleTextChange(index, e.target.value)}
                className="w-full min-h-[40px] resize-y outline-none text-slate-700 text-sm font-mono bg-transparent border-none focus:ring-0 p-0 placeholder:text-slate-400"
                placeholder="在此输入文本..."
                style={{ fieldSizing: 'content' } as any}
              />
            </div>
          );
        } else {
          return (
            <div key={index} className="markdown-preview overflow-x-auto p-0 border-b border-slate-100 last:border-0">
              <table className="w-full text-sm text-left rtl:text-right text-slate-500">
                <thead className="text-xs text-slate-700 uppercase bg-slate-50 sticky top-0 z-10">
                  <tr>
                    {block.headers.map((header, colIndex) => (
                      <th key={colIndex} scope="col" className="px-6 py-3 min-w-[120px] border border-slate-200">
                        <input
                          type="text"
                          value={header}
                          onChange={(e) => handleHeaderChange(index, colIndex, e.target.value)}
                          className="w-full bg-transparent border-none outline-none focus:ring-0 font-bold text-slate-900 p-0"
                        />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="bg-white border-b hover:bg-slate-50">
                      {row.map((cell, colIndex) => (
                        <td key={colIndex} className="px-6 py-4 border border-slate-200 min-w-[150px] align-top">
                          <textarea
                            value={cell}
                            onChange={(e) => handleCellChange(index, rowIndex, colIndex, e.target.value)}
                            className="w-full h-full min-h-[60px] resize-none bg-transparent border-none outline-none focus:ring-0 text-slate-600 text-sm p-0 font-normal"
                            style={{ fieldSizing: 'content' } as any}
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
      {blocks.length === 0 && (
         <textarea
            value={content}
            onChange={(e) => onChange(e.target.value)}
            className="w-full min-h-[360px] p-4 text-sm font-mono outline-none resize-none"
            placeholder="正在加载或输入内容..."
         />
      )}
    </div>
  );
}
