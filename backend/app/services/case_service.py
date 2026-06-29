import pandas as pd
from fastapi import HTTPException
from app.config import settings

class CaseService:
    CASES_EXCEL_PATH = settings.cases_excel_path

    def __init__(self):
        self.db = self._read_mock_db_from_excel(self.CASES_EXCEL_PATH) # mock db from csv

    def get_case(self, case_id: int):
        case = self.db.loc[self.db['case_id'] == case_id]

        if case.empty:
            raise HTTPException(status_code=404, detail="Case not found")

        return case.iloc[0].to_dict()

    def _read_mock_db_from_excel(self, file_path: str):
        df = pd.read_excel(file_path, sheet_name=0)
        return df
