
{showRenamePreview && (
  <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
    <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col">
      <div className="p-6 border-b">
        <h2 className="text-2xl font-bold">Rename Preview</h2>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="space-y-4">
          {renamePreviews.map((preview, idx) => (
            <div key={idx} className={`p-4 rounded-lg border-2 ${preview.changed ? 'bg-blue-50 border-blue-200' : 'bg-gray-50'}`}>
              {preview.changed ? (
                <>
                  <div className="text-sm text-gray-600 mb-2">From:</div>
                  <div className="font-mono text-sm mb-3">{preview.old_path.split('/').pop()}</div>
                  <div className="text-sm text-gray-600 mb-2">To:</div>
                  <div className="font-mono text-sm text-green-700">{preview.new_path.split('/').pop()}</div>
                </>
              ) : (
                <div className="text-sm text-gray-600">No change needed</div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="p-6 border-t flex justify-end gap-3">
        <button onClick={() => setShowRenamePreview(false)} className="btn btn-secondary">Cancel</button>
        <button onClick={handleRenameConfirm} className="btn btn-primary">Confirm Rename</button>
      </div>
    </div>
  </div>
)}
