"""internet photo slots: longer asset_path (web addresses), integration 'remote'

Revision ID: 0003
Revises: 0002
"""
from alembic import op
import sqlalchemy as sa

revision = '0003'
down_revision = '0002'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column('placements', 'asset_path', type_=sa.String(length=2048), existing_type=sa.String(length=300), existing_nullable=True)
    op.drop_constraint('ck_placement_integration', 'placements', type_='check')
    op.create_check_constraint('ck_placement_integration', 'placements', "integration in ('widget','asset','remote')")


def downgrade() -> None:
    op.execute("DELETE FROM placements WHERE integration = 'remote'")
    op.drop_constraint('ck_placement_integration', 'placements', type_='check')
    op.create_check_constraint('ck_placement_integration', 'placements', "integration in ('widget','asset')")
    op.alter_column('placements', 'asset_path', type_=sa.String(length=300), existing_type=sa.String(length=2048), existing_nullable=True)
